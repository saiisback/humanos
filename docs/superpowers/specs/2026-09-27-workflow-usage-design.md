# HumanOS response usage and cost transparency

## Approved intent

Show actual Jev and DeepSeek input/output tokens and retry attempts beneath each workflow response. Show estimated model charges separately from service charges, plus a clearly labelled API-price comparison for named OpenAI and Claude models. Never imply that a subscription has a per-message price or that an equivalent-token estimate measures the same task's cost.

## Current gap

The model transport and workflow outputs do not retain a durable per-attempt usage ledger. Some Jev responses contain usage, but it is discarded. Browser preparation records call counts, not tokens. A UI-only change cannot honestly implement this request.

## Design

1. Add a server-owned usage ledger, keyed by workflow, phase, run/step when present, provider request/attempt ID and model. Planning belongs to a workflow version; execution belongs to a run. Do not count planning again on every rerun.
2. Record each attempted provider request, including retries and invalid-content recovery calls. Capture provider-reported input/output/cache token counts when available. A timeout without usage is an unknown-cost attempt, not zero. Cache hits that avoid a request are distinct from provider cache-token billing.
3. Keep usage metadata separate from generated content schemas. Never let model text supply its own charge, model identity, workflow ID or authorization context. Do not record prompts, API keys, personal details or raw provider responses in the ledger.
4. Use a versioned server-side price table with currency, model/provider, effective date, source URL and input/output/cache rates. Verify current official provider prices before populating it. Missing or unsupported rates produce 'price unavailable'. Preserve the applied price version with the estimate.
5. Report known subtotals and coverage. Unknown usage or rates prevent a complete total or savings percentage. Handle cached/reasoning tokens according to the specific provider's documented billing semantics; never count them twice.
6. Record search/email/browser operation counts separately. Monetary service cost is unavailable unless a verified applicable per-use rate exists; do not apportion subscriptions into invented per-call charges. Gas is not a model charge.
7. Return an account-authorized usage summary through the existing workflow detail path. Historical runs without telemetry remain 'usage unavailable'; do not reconstruct token counts from text length.
8. Add a compact footer below results: Jev/DeepSeek tokens, attempts and known estimated USD model cost. Expand 'Cost details' for provider/model breakdown, unknown attempts, service counts and the pricing date.
9. Compare the same reported input/output token volumes at named OpenAI and Claude API rates. Label this 'equivalent-token API estimate, not a measured same-task run'; different tokenizers and reasoning/tool behavior limit comparability. Do not compare against ChatGPT/Claude subscriptions, claim task-equivalent savings, or make extra paid model calls for comparison.

## Verification

Test first: successful usage parsing, absent usage, zero usage, malformed counts, retry accounting, invalid-output recovery, transport timeout, cache accounting, partial totals, old runs, reruns without duplicated planning, account isolation and UI labels. Test fixed price fixtures deterministically. Run repository tests/typecheck/build and inspect the result footer in the actual browser. A live run may demonstrate reported usage but is not a provider invoice reconciliation.

## Scope

This change does not alter final confirmation, ENS authorization or connector permissions. Restaurant booking is separate: Gurunavi has no HumanOS adapter yet, requires an email verification link, and its observed cancellation terms require explicit review. No reservation is created by this work.
