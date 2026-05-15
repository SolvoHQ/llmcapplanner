# LLM Cap Planner

A deterministic, **client-side** calculator. No API calls, no build step, no server — a single
`index.html` (inline CSS + vanilla JS). Nothing you type leaves the browser.

You pick an LLM model + provider, enter expected requests/min and avg input/output tokens per
request, and confirm your rate-limit tier numbers. It shows:

1. **Projected cost** — per request / per day / per month at 24/7 sustained load, plus cost / 1M requests.
2. **Which rate-limit dimension binds first** (the 429 ceiling) with utilization % and headroom on each.
3. **A per-second quantization warning** when RPM is the binding (or >70% util) dimension — minute caps
   are enforced ~per-second, so a single-second burst can 429 even under the per-minute limit.

## Rate-limit honesty

There is no fabricated per-tier matrix. Tier limit fields are **editable inputs you confirm from your
own dashboard**, pre-filled with documented May-2026 anchor defaults labelled "planning baseline".
A limit set to `0`/blank is treated as *unset* and excluded from the binding calc.

## Data snapshot

Pricing & model snapshot dated **2026-05-15** (USD per 1,000,000 tokens). Presets change — verify
current numbers in your provider dashboard:

- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits)
- [OpenAI rate limits](https://platform.openai.com/docs/guides/rate-limits)

Maintained by SolvoHQ.
