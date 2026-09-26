# Live email flow: 2026-09-26

## Fixed

The real email binding used generated `subject` and `body` references inside
`connector.call.arguments`. Graph validation accepted top-level references but
rejected these nested values against the executable string-record schema,
silently eliminating the connector candidate during assembly.

Planning now accepts ancestor string-output references in string records while
checking their shape, ancestry, content variant and output kind. The runner still
resolves references and parses the unchanged strict executable schema before
authorization or dispatch. Confirmation and ENS checks are unchanged.

The fixed Jev catalog descriptions now explain the existing confirmation gate and
connector-write semantics. No score thresholds or decisions were overridden.
Booking clarification asks for reservation details and a site, and explicitly
states that production booking is unavailable until that site is integrated.

## Evidence

- Regression first failed with `connector.call: INVALID_BLOCK_INPUT`, then passed.
- Full suite: 851 TypeScript tests and 26 contract tests passed after the confirmation-expiry recovery fix.
- Workspace typecheck and build passed; model tests/typecheck rerun after the
  description-only update passed. Independent scoped review found no issues.
- Live workflow `7d2de1ea-615b-459a-9b96-7ec52c3a1b73` passed real Jev assembly
  after the fix: content generation, human confirmation, connector send.
- Real DeepSeek produced the requested exact email. The UI reached the final
  confirmation with sender `agent@fintrix.ltd`, recipient
  `karthiksaiketha@gmail.com`, subject `HumanOS live email test`, and body:
  `Hi Karthik, this is a real email-delivery test from HumanOS. No booking has been made.`

## Live send verified

After the user's explicit send approval, the old five-minute confirmation had
expired. Added a refresh control that requeues the same run for preparation,
without consuming approval, recreating the run, or sending. The runner produced a
new confirmation for the unchanged exact payload. It was confirmed through the UI.

HumanOS then showed all three steps completed and receipt
`01a0dcae-b139-72ec-b96d-890d2bb7fe42`. A read-only lookup of this exact Resend email
returned `last_event: delivered`, the expected sender, recipient and subject.
This is provider-reported delivery, not proof of the recipient opening the mail.

## Remaining limitations

ENS registration review returned a conflict message; this workflow remains
account-owned, not ENS-delegated.
No restaurant booking was attempted. A real booking site and reservation details
are still required; the production recipe registry remains empty.
