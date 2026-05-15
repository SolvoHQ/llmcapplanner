# llmcapplanner-mcp-server

An MCP (Model Context Protocol) stdio server that answers one question well:

> For this model, tier, and traffic profile — **what will it cost per month, and which rate-limit dimension will 429 first?**

It is the [llmcapplanner](https://llmcapplanner.vercel.app) calculator as a tool an
LLM agent can call. The computation is **embedded and deterministic** — no provider
API is called — using a **date-stamped pricing + rate-limit snapshot** bundled into
the package.

## Why this is different

- **Dated snapshot, not silent stale defaults.** Every result includes
  `snapshot_version` (currently `2026-05-15`) so you know exactly how fresh the
  numbers are.
- **Tells you *which* limit 429s first.** Most calculators only show cost. This one
  reports the single binding dimension — RPM / ITPM / OTPM (Anthropic) or RPM / TPM
  (OpenAI) — with exact per-minute headroom, because that is the thing that actually
  caps your throughput.
- **Offline / free / fast.** No network round-trip.

## The one tool: `llm_capacity_plan`

Input:

| arg       | type            | notes                                              |
|-----------|-----------------|----------------------------------------------------|
| `provider`| `"anthropic" \| "openai"` |                                          |
| `model`   | string          | e.g. `claude-sonnet-4-6`, `gpt-5.4`                |
| `tier`    | string          | Anthropic `t1`/`t4`; OpenAI `t1`/`t5`              |
| `rpm`     | number > 0      | sustained requests per minute                      |
| `in_tok`  | number ≥ 0      | avg input tokens / request                         |
| `out_tok` | number ≥ 0      | avg output tokens / request                        |

Output (`structuredContent`):

```json
{
  "monthly_cost": 349920,
  "monthly_cost_formatted": "$349,920.00",
  "first_binding_429_dim": "OTPM",
  "headroom_per_dim": { "RPM": 3400, "ITPM": 800000, "OTPM": 100000 },
  "util_per_dim": { "RPM": 15, "ITPM": 60, "OTPM": 75 },
  "will_429": false,
  "snapshot_version": "2026-05-15"
}
```

### Example call

Request:

```json
{
  "name": "llm_capacity_plan",
  "arguments": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "tier": "t4",
    "rpm": 600,
    "in_tok": 2000,
    "out_tok": 500
  }
}
```

Response: see the JSON above — `$349,920.00/mo`, **OTPM binds first** at 75%
utilization, you are within all limits.

### Errors

Returned as `isError: true` text (not exceptions), with actionable guidance:

- Unknown `model` → lists the valid models for that provider.
- Unknown `tier`  → lists the valid tiers for that provider/model.
- `rpm <= 0` / negative tokens → rejected by input validation.

## Running it

### From a built checkout (current — not yet npm-published)

```bash
cd mcp
npm install
npm run build
node dist/index.js     # speaks MCP over stdio
```

### Via npx (intended, once published to npm)

```bash
npx -y llmcapplanner-mcp-server
```

### Claude Desktop / MCP client config

Add to your MCP client config (e.g. `claude_desktop_config.json`). Once published:

```json
{
  "mcpServers": {
    "llmcapplanner": {
      "command": "npx",
      "args": ["-y", "llmcapplanner-mcp-server"]
    }
  }
}
```

Until then, point at the built file directly:

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

## Data freshness

All pricing and rate-limit numbers come from `snapshot.json`
(version `2026-05-15`), bundled in the npm tarball. Presets change — verify
current numbers in your provider dashboard. The returned `snapshot_version`
always tells you which snapshot produced the answer.

## License

MIT © 2026 SolvoHQ
