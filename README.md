# LLM Cap Planner

**An LLM API cost calculator that leads with a *dated* (May 2026) pricing + rate-limit snapshot and tells you *which 429 dimension binds first* — RPM vs ITPM vs OTPM vs TPM — not a stale 2024 table and not just a cost number.**

Live app: **<https://llmcapplanner.vercel.app>**

Most "LLM cost calculators" give you a dollar figure off numbers that were true sometime in 2024. That is the wrong question. When you push real traffic at Anthropic Claude or OpenAI GPT, you do not fail on cost — you fail on a `429 Too Many Requests`, and *which* limit you hit first (requests per minute vs input/output tokens per minute) determines how you have to re-architect. This tool answers that, against a snapshot dated **2026-05-15**.

It is a deterministic, **client-side** calculator. No API calls, no build step, no server — a single `index.html` (inline CSS + vanilla JS). Nothing you type leaves the browser.

You pick an LLM model + provider, enter expected requests/min and avg input/output tokens per request, and confirm your rate-limit tier numbers. It shows:

1. **Projected cost** — per request / per day / per month at 24/7 sustained load, plus cost / 1M requests.
2. **Which rate-limit dimension binds first** (the 429 ceiling) with utilization % and headroom on each — RPM, ITPM, OTPM for Anthropic; RPM, TPM for OpenAI.
3. **A per-second quantization warning** when RPM is the binding (or >70% util) dimension — minute caps are enforced ~per-second, so a single-second burst can 429 even under the per-minute limit.

## Rate-limit honesty

There is no fabricated per-tier matrix. Tier limit fields are **editable inputs you confirm from your own dashboard**, pre-filled with documented May-2026 anchor defaults labelled "planning baseline". A limit set to `0`/blank is treated as *unset* and excluded from the binding calc.

This is the difference between this and a hard-coded table that quietly rots: you always know the snapshot date, and you correct the tier numbers to *your* account before trusting the binding result.

## MCP server

There is an **MCP (Model Context Protocol) stdio server** in [`mcp/`](mcp/) that wires LLM capacity planning directly into your AI coding agent. It exposes one tool:

```
llm_capacity_plan(provider, model, tier, rpm, in_tok, out_tok)
```

It returns `monthly_cost`, `first_binding_429_dim`, and `headroom_per_dim` (plus per-dimension utilization and a `will_429` flag) — computed off the **same dated snapshot** the web app uses, fully offline and deterministic. Every response carries `snapshot_version` so the agent knows exactly how fresh the numbers are.

Ask your agent "what tier do I need for 600 rpm of claude-sonnet-4-6 at 2k in / 500 out, and what 429s first?" and it can answer with real arithmetic instead of a hallucinated guess.

The compiled `dist/index.js` is committed, so it runs straight from a clone with no build step. Add this to your Claude Desktop / MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "llmcapplanner": {
      "command": "node",
      "args": ["/absolute/path/to/llmcapplanner/mcp/dist/index.js"]
    }
  }
}
```

See [`mcp/README.md`](mcp/README.md) for the full tool schema, example calls, error behavior, and `npx` usage.

## Data snapshot

Pricing & model snapshot dated **2026-05-15** (USD per 1,000,000 tokens). Presets change — verify current numbers in your provider dashboard:

- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits)
- [OpenAI rate limits](https://platform.openai.com/docs/guides/rate-limits)
- [Machine-readable dataset (JSON)](https://llmcapplanner.vercel.app/v1/models.json) — versioned, freshness-stamped; built for agents/CI to consume.

## Data contract

The dataset is served as a single versioned JSON at **`https://llmcapplanner.vercel.app/v1/models.json`** (CORS-open, `application/json`). Fields: `schema_version` (currently `1.0`), `last_verified` (date of the most recent manual check against the official provider docs in `sources`), pricing per 1M tokens, and per-model / per-tier rate-limit anchors. Pricing and limits are re-verified whenever a model launches or a price/limit changes; a breaking schema change increments `schema_version` and the prior version stays reachable at its path. Copy-runnable:

```sh
curl -s https://llmcapplanner.vercel.app/v1/models.json | jq '{last_verified, schema_version}'
```

(`/snapshot.json` is kept as a stable alias of the same payload.)

## Keywords

For anyone searching: this is an **LLM API cost calculator** and **LLM capacity planning** tool focused on the **rate limit 429** problem — **Anthropic Claude rate limits** and **OpenAI GPT rate limits**, the **ITPM OTPM RPM** (and TPM) dimensions, and which one binds first under sustained load. Available both as a web app and as an **MCP server** for AI agents.

Maintained by SolvoHQ.
