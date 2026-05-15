#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---- load the bundled dated snapshot (pricing + rate-limit anchors) ----
// The snapshot ships next to the package root (one level up from dist/index.js).
// We read it with fs.readFileSync (NOT a TS `import ... .json`) so tsc never
// has to type-check the data file and the JSON ships verbatim in the tarball.
const __dirname = dirname(fileURLToPath(import.meta.url));

type Price = { input: number; output: number };
type AnthropicPreset = { rpm: number; itpm: number; otpm: number };
type OpenAIPreset = { rpm: number; tpm: number };

interface Snapshot {
  version: string;
  generated_at: string;
  currency: string;
  providers: {
    anthropic: {
      models: Record<string, Price>;
      rate_limits: {
        per_model: Record<string, Record<string, AnthropicPreset>>;
      };
    };
    openai: {
      models: Record<string, Price>;
      rate_limits: {
        per_tier: Record<string, OpenAIPreset>;
      };
    };
  };
}

function loadSnapshot(): Snapshot {
  // Try the shipped location (package root) first, then a dev fallback.
  const candidates = [
    join(__dirname, "..", "snapshot.json"),
    join(__dirname, "snapshot.json"),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as Snapshot;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `Could not load bundled snapshot.json. Looked in: ${candidates.join(", ")}`,
  );
}

const SNAPSHOT = loadSnapshot();

const PROVIDERS = ["anthropic", "openai"] as const;
type Provider = (typeof PROVIDERS)[number];

// ---- input / output schemas ----
const InputSchema = {
  provider: z
    .enum(PROVIDERS)
    .describe('LLM provider. One of "anthropic" or "openai".'),
  model: z
    .string()
    .min(1, "model is required")
    .describe(
      'Model id as it appears in the snapshot, e.g. "claude-sonnet-4-6" (anthropic) or "gpt-5.4" (openai). An invalid id returns an error listing valid models.',
    ),
  tier: z
    .string()
    .min(1, "tier is required")
    .describe(
      'Rate-limit tier. Anthropic: "t1" or "t4". OpenAI: "t1" or "t5". An invalid tier returns an error listing valid tiers for the chosen provider.',
    ),
  rpm: z
    .number()
    .positive("rpm must be > 0")
    .describe("Sustained requests per minute you intend to send (> 0)."),
  in_tok: z
    .number()
    .min(0, "in_tok must be >= 0")
    .describe("Average input (prompt) tokens per request."),
  out_tok: z
    .number()
    .min(0, "out_tok must be >= 0")
    .describe("Average output (completion) tokens per request."),
};

const OutputSchema = {
  monthly_cost: z
    .number()
    .describe(
      "Projected 30-day spend in USD, rounded to 2 decimals. = cost_per_request * rpm * 60 * 24 * 30.",
    ),
  monthly_cost_formatted: z
    .string()
    .describe('Same value as a human string, e.g. "$349,920.00".'),
  first_binding_429_dim: z
    .string()
    .describe(
      "The rate-limit dimension that hits its ceiling first (highest utilization). RPM/ITPM/OTPM for anthropic; RPM/TPM for openai. This is what 429s before anything else when you scale up.",
    ),
  headroom_per_dim: z
    .record(z.string(), z.number())
    .describe(
      "limit - usage for each dimension (per minute). Negative means you are already over that limit and will 429.",
    ),
  util_per_dim: z
    .record(z.string(), z.number())
    .describe(
      "usage / limit * 100 for each dimension (percent, full precision). >100 means over the limit.",
    ),
  will_429: z
    .boolean()
    .describe(
      "True if ANY dimension's projected usage exceeds its limit (utilization > 100%) at the given rpm/token profile.",
    ),
  snapshot_version: z
    .string()
    .describe(
      'Date-stamped version of the pricing/rate-limit data used, e.g. "2026-05-15". Numbers are only as fresh as this snapshot.',
    ),
};

type Dim = {
  key: string;
  usage: number;
  limit: number;
  util: number;
  headroom: number;
};

type PlanResult = {
  monthly_cost: number;
  monthly_cost_formatted: string;
  first_binding_429_dim: string;
  headroom_per_dim: Record<string, number>;
  util_per_dim: Record<string, number>;
  will_429: boolean;
  snapshot_version: string;
};

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: PlanResult;
  isError?: boolean;
};

// Mirrors fmtUSD in index.html for the >=100 case (always 2 decimals here, as
// the boundary spec requires "$x,xxx.xx" for the monthly figure).
function fmtUSD2(x: number): string {
  return (
    "$" +
    x.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function validModels(provider: Provider): string[] {
  return Object.keys(SNAPSHOT.providers[provider].models);
}

function validTiers(provider: Provider): string[] {
  if (provider === "anthropic") {
    // Tiers are defined per-model; collect the union (they are identical
    // across models in practice, but enumerate defensively).
    const set = new Set<string>();
    const perModel = SNAPSHOT.providers.anthropic.rate_limits.per_model;
    for (const m of Object.keys(perModel)) {
      for (const t of Object.keys(perModel[m])) set.add(t);
    }
    return [...set];
  }
  return Object.keys(SNAPSHOT.providers.openai.rate_limits.per_tier);
}

function tiersForModel(provider: Provider, model: string): string[] {
  if (provider === "anthropic") {
    const perModel = SNAPSHOT.providers.anthropic.rate_limits.per_model[model];
    return perModel ? Object.keys(perModel) : validTiers(provider);
  }
  return validTiers(provider);
}

// Pure, deterministic port of the compute() function in index.html.
function computePlan(
  provider: Provider,
  model: string,
  tier: string,
  rpm: number,
  inTok: number,
  outTok: number,
): PlanResult {
  const price = SNAPSHOT.providers[provider].models[model];

  // cost (identical math to index.html compute())
  const costReq = (inTok / 1e6) * price.input + (outTok / 1e6) * price.output;
  const reqMonth = rpm * 60 * 24 * 30;
  const monthlyRaw = costReq * reqMonth;
  const monthly_cost = Math.round(monthlyRaw * 100) / 100;

  // dimensions
  let dims: { key: string; usage: number; limit: number }[];
  if (provider === "anthropic") {
    const preset = SNAPSHOT.providers.anthropic.rate_limits.per_model[model][tier];
    dims = [
      { key: "RPM", usage: rpm, limit: preset.rpm },
      { key: "ITPM", usage: rpm * inTok, limit: preset.itpm },
      { key: "OTPM", usage: rpm * outTok, limit: preset.otpm },
    ];
  } else {
    const preset = SNAPSHOT.providers.openai.rate_limits.per_tier[tier];
    dims = [
      { key: "RPM", usage: rpm, limit: preset.rpm },
      { key: "TPM", usage: rpm * (inTok + outTok), limit: preset.tpm },
    ];
  }

  // Only dimensions with a positive limit constrain (matches index.html).
  const included: Dim[] = dims
    .filter((d) => d.limit > 0)
    .map((d) => ({
      ...d,
      util: (d.usage / d.limit) * 100,
      headroom: d.limit - d.usage,
    }));

  let binding: Dim | null = null;
  for (const d of included) {
    if (!binding || d.util > binding.util) binding = d;
  }

  const headroom_per_dim: Record<string, number> = {};
  const util_per_dim: Record<string, number> = {};
  for (const d of included) {
    headroom_per_dim[d.key] = d.headroom;
    util_per_dim[d.key] = d.util;
  }

  const will_429 = included.some((d) => d.util > 100);

  return {
    monthly_cost,
    monthly_cost_formatted: fmtUSD2(monthly_cost),
    first_binding_429_dim: binding ? binding.key : "",
    headroom_per_dim,
    util_per_dim,
    will_429,
    snapshot_version: SNAPSHOT.version,
  };
}

function renderText(provider: Provider, model: string, tier: string, r: PlanResult): string {
  const dimLines = Object.keys(r.util_per_dim).map((k) => {
    const util = r.util_per_dim[k];
    const headroom = r.headroom_per_dim[k];
    const flag =
      util > 100
        ? " — OVER LIMIT (will 429)"
        : k === r.first_binding_429_dim
          ? " — binds first"
          : "";
    return `  - ${k}: ${util.toFixed(2)}% utilization, headroom ${headroom.toLocaleString("en-US")}/min${flag}`;
  });
  return [
    `# LLM capacity plan — ${provider} / ${model} / tier ${tier}`,
    "",
    `Projected monthly cost: **${r.monthly_cost_formatted}** (${r.monthly_cost})`,
    "",
    r.will_429
      ? `**WILL 429** — at least one dimension is over its limit. First binding: **${r.first_binding_429_dim}**.`
      : `Within all configured limits. **${r.first_binding_429_dim}** binds first — that is your scaling ceiling.`,
    "",
    "Per-dimension:",
    ...dimLines,
    "",
    `Basis: dated snapshot version **${r.snapshot_version}** (pricing + rate-limit anchors). Verify current numbers in your provider dashboard.`,
  ].join("\n");
}

const server = new McpServer({
  name: "llmcapplanner-mcp-server",
  version: "0.1.0",
});

server.registerTool(
  "llm_capacity_plan",
  {
    title: "LLM capacity plan (cost + which 429 binds first)",
    description: `Plan LLM API capacity: projected monthly cost AND which rate-limit dimension 429s first.

Given a provider, model, rate-limit tier, and a traffic profile (requests/min + avg input/output tokens), this computes — locally and deterministically — your projected 30-day spend and, more usefully, the single rate-limit dimension that hits its ceiling first. That "first binding" dimension is what actually caps your throughput and what you must raise (higher tier / quota increase) before scaling.

Differentiators:
  - Dated snapshot: all pricing and rate-limit numbers come from a date-stamped snapshot (currently ${SNAPSHOT.version}). The returned snapshot_version tells you exactly how fresh the math is — no silent stale defaults.
  - Which-429-binds-first: most calculators only show cost. This one tells you whether it is RPM, ITPM, OTPM (anthropic) or RPM, TPM (openai) that throttles you first, with exact headroom per dimension.
  - No network call: the computation is embedded; it does not hit any provider API, so it is fast, free, and offline-safe.

Args:
  - provider (string): "anthropic" or "openai".
  - model (string): model id from the snapshot, e.g. "claude-sonnet-4-6", "gpt-5.4".
  - tier (string): anthropic "t1"/"t4"; openai "t1"/"t5".
  - rpm (number > 0): sustained requests per minute.
  - in_tok (number >= 0): average input tokens per request.
  - out_tok (number >= 0): average output tokens per request.

Returns structured content with shape:
  {
    "monthly_cost": number,             // USD, 2-dp, = cost_per_req * rpm * 60 * 24 * 30
    "monthly_cost_formatted": string,   // e.g. "$349,920.00"
    "first_binding_429_dim": string,    // dimension with highest utilization
    "headroom_per_dim": { [dim]: number },  // limit - usage, per minute (negative = over)
    "util_per_dim": { [dim]: number },      // usage/limit*100, percent
    "will_429": boolean,                // true if any dim > 100% utilization
    "snapshot_version": string          // date-stamped data version
  }
  The text content is a human-readable summary of the same result.

Use when:
  - "If I run claude-sonnet-4-6 at 600 rpm with 2k in / 500 out on tier 4, what does it cost and what rate limit do I hit first?"
  - Sizing a tier upgrade ("am I going to 429, and on which dimension?").
  - Comparing models/tiers for a known traffic profile.

Do NOT use when:
  - You need live, to-the-minute provider pricing — this uses a dated snapshot (check snapshot_version).
  - The provider/model is not in the snapshot (only anthropic + openai families listed in the May-2026 snapshot are supported).
  - You need per-day RPD/TPD ceilings — only per-minute dimensions are modelled.

Error modes (returned as isError text, not exceptions):
  - Unknown provider/model: lists the valid models for that provider.
  - Unknown tier: lists the valid tiers for that provider/model.
  - rpm <= 0 or negative tokens: rejected by input validation with a clear message.`,
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ provider, model, tier, rpm, in_tok, out_tok }): Promise<ToolResult> => {
    const p = provider as Provider;

    // Validate model.
    if (!(model in SNAPSHOT.providers[p].models)) {
      const models = validModels(p);
      return {
        content: [
          {
            type: "text",
            text: `Unknown model "${model}" for provider "${p}". Valid ${p} models in snapshot ${SNAPSHOT.version}:\n  - ${models.join("\n  - ")}`,
          },
        ],
        isError: true,
      };
    }

    // Validate tier (provider- and, for anthropic, model-specific).
    const tiers = tiersForModel(p, model);
    let tierOk = false;
    if (p === "anthropic") {
      tierOk =
        !!SNAPSHOT.providers.anthropic.rate_limits.per_model[model] &&
        tier in SNAPSHOT.providers.anthropic.rate_limits.per_model[model];
    } else {
      tierOk = tier in SNAPSHOT.providers.openai.rate_limits.per_tier;
    }
    if (!tierOk) {
      return {
        content: [
          {
            type: "text",
            text: `Unknown tier "${tier}" for ${p} model "${model}". Valid tiers: ${tiers
              .map((t) => `"${t}"`)
              .join(", ")} (snapshot ${SNAPSHOT.version}).`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = computePlan(p, model, tier, rpm, in_tok, out_tok);
      return {
        content: [{ type: "text", text: renderText(p, model, tier, result) }],
        structuredContent: result,
      };
    } catch (e: any) {
      return {
        content: [
          {
            type: "text",
            text: `Computation failed unexpectedly: ${e?.message || String(e)}. This usually means the snapshot data is malformed for ${p}/${model}/${tier}.`,
          },
        ],
        isError: true,
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `llmcapplanner-mcp-server v0.1.0 listening on stdio (snapshot ${SNAPSHOT.version})`,
  );
}

main().catch((err) => {
  console.error("Fatal error starting llmcapplanner-mcp-server:", err);
  process.exit(1);
});
