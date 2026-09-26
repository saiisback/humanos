# Usage estimate rate snapshot — 2026-09-27

USD per million tokens, standard API rates, checked against official pages:

| Provider/model | Input | Output | Cached input |
| --- | ---: | ---: | ---: |
| OpenCode Jev 1.13 | 0.042 | 0 | not applicable |
| OpenCode DeepSeek V4.1 Flash | 0.30 | 1.20 | 0.006 |
| OpenAI GPT-4.1 mini (comparison) | 0.40 | 1.60 | excluded from comparison |
| Anthropic Claude Sonnet 4.6 (comparison) | 3 | 15 | excluded from comparison |

Sources: https://opencode.ai/docs/zen/, https://developers.openai.com/api/docs/models/gpt-4.1-mini, https://platform.claude.com/docs/en/about-claude/pricing

Comparison reuses reported token counts with uncached standard pricing. Different tokenizers, output lengths, reasoning and tool calls mean this is not a measured same-task price. No subscription, tax, payment processing, gas or service subscription costs are included. Missing cache data for DeepSeek means cost unavailable, not an assumed full-rate bill. Output tokens are billed once; reasoning subtotals are not added again. Never change this historical snapshot in place; add a new version.

## Comparison update — 2026-09-27, GPT-5.6 Sol

The UI now compares against GPT-5.6 Sol instead of GPT-4.1 mini. Official source: https://developers.openai.com/api/docs/models/gpt-5.6-sol. Standard promotional rates: $4 input / $20 output per million tokens; requests above 272,000 input tokens use $8 / $30 for the full request. The threshold is applied per attempt, not to the workflow aggregate. These promotional prices are stated as available at least through November 21, 2026. Sonnet 4.6 remains $3 / $15. No actual HumanOS attempt pricing was changed.
