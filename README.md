# LLM Cap Planner

**A dated (May 2026) per-org/per-tier LLM rate-limit-ceiling dataset + planner: for a given model at a given org tier, which limit — RPM vs ITPM vs OTPM vs TPM — binds first, and at what number, before you get 429'd in prod.**

Live app: **<https://llmcapplanner.vercel.app>**

When you push real traffic at Anthropic Claude or OpenAI GPT, you don't fail on cost — you fail on a `429 Too Many Requests`, and *which* limit you hit first determines how you have to re-architect. This is a real, recurring pain in user language:

- **stagewise-io/stagewise#927** — *"This request would exceed your organization's rate limit of 30,000 input tokens per minute ... something to consider for indie devs"*
- **philspins/opendocket#38** — *"We are currently in Tier 3 ... api returned 429 (rate_limit_error): This request would exceed your organization's rate limit of 450,000 input tokens per minute"*
- **Jakedismo/codegraph-rust#72** — *"broad agentic MCP calls can immediately exceed the account/model input-token-per-minute limit ... lacks rate-limit-aware budgeting"*

The incumbents don't answer this. models.dev (`curl https://models.dev/api.json`) and the LiteLLM model catalog cover **pricing + context window only** — neither carries per-org/per-tier rate-limit ceilings. That per-tier *"which limit binds first"* data is what this provides, against a snapshot dated **2026-05-15**.

It is a deterministic, **client-side** planner. No API calls, no build step, no server — a single `index.html` (inline CSS + vanilla JS). Nothing you type leaves the browser. It also includes a cost calculator on top of the rate-limit dataset (see below) — but cost is secondary supporting data, not the headline.

You pick a model + provider, enter expected requests/min and avg input/output tokens per request, and confirm your rate-limit tier numbers. It shows:

1. **Which rate-limit dimension binds first** (the 429 ceiling) with utilization % and headroom on each — RPM, ITPM, OTPM for Anthropic; RPM, TPM for OpenAI.
2. **A per-second quantization warning** when RPM is the binding (or >70% util) dimension — minute caps are enforced ~per-second, so a single-second burst can 429 even under the per-minute limit.
3. **Projected cost** (secondary) — per request / per day / per month at 24/7 sustained load, plus cost / 1M requests.

## Rate-limit honesty

There is no fabricated per-tier matrix. Tier limit fields are **editable inputs you confirm from your own dashboard**, pre-filled with documented May-2026 anchor defaults labelled "planning baseline". A limit set to `0`/blank is treated as *unset* and excluded from the binding calc.

This is the difference between this and a hard-coded table that quietly rots: you always know the snapshot date, and you correct the tier numbers to *your* account before trusting the binding result.

## MCP server

There is an **MCP (Model Context Protocol) stdio server** in [`mcp/`](mcp/) that wires LLM capacity planning directly into your AI coding agent — a planner/calculator on top of the rate-limit dataset. It exposes one tool:

```
llm_capacity_plan(provider, model, tier, rpm, in_tok, out_tok)
```

It returns `first_binding_429_dim`, `headroom_per_dim` (plus per-dimension utilization and a `will_429` flag), and `monthly_cost` as a secondary field — computed off the **same dated snapshot** the web app uses, fully offline and deterministic. Every response carries `snapshot_version` so the agent knows exactly how fresh the numbers are.

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

Per-org/per-tier rate-limit-ceiling snapshot dated **2026-05-15**, with pricing as secondary supporting data. Presets change — verify current numbers in your provider dashboard:

- [Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits)
- [OpenAI rate limits](https://platform.openai.com/docs/guides/rate-limits)
- [Rate-limit dataset (JSON)](https://llmcapplanner.vercel.app/v1/rate-limits.json) — rate-limit-first, versioned, freshness-stamped; built for agents/CI to consume.
- [Combined dataset incl. pricing (JSON)](https://llmcapplanner.vercel.app/v1/models.json) — rate limits + pricing.
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)

## Data contract

The first-class dataset is the rate-limit-first JSON at **`https://llmcapplanner.vercel.app/v1/rate-limits.json`** (CORS-open, `application/json`) — per-org/per-tier rate-limit ceilings, no pricing. No incumbent dataset (models.dev, LiteLLM) carries per-tier rate limits; they are pricing + context only. The combined dataset that *also* carries pricing is at **`/v1/models.json`**, and **`/snapshot.json`** is a byte-identical stable alias of it. Fields: `schema_version` (currently `1.0`), `last_verified` (date of the most recent manual check against the official provider docs in `sources`), and per-model / per-tier rate-limit anchors. Limits and pricing are re-verified whenever a model launches or a limit/price changes; a breaking schema change increments `schema_version` and the prior version stays reachable at its path. Copy-runnable:

```sh
curl -s https://llmcapplanner.vercel.app/v1/rate-limits.json | jq '.providers.anthropic.per_model'
```

## Keywords

For anyone searching: this is an **LLM API rate-limit ceiling dataset** and **LLM capacity planning** tool focused on the **rate limit 429** problem — **Anthropic Claude rate limits** and **OpenAI GPT rate limits**, the **ITPM OTPM RPM** (and TPM) dimensions, and which one binds first per org tier under sustained load. Pricing / cost is included as a secondary field. Available both as a web app and as an **MCP server** for AI agents.

Maintained by SolvoHQ.
