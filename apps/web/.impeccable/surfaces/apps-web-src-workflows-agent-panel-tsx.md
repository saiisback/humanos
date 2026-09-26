---
version: 1
slug: "apps-web-src-workflows-agent-panel-tsx"
primary_target: "apps/web/src/workflows/agent-panel.tsx"
related_targets: ["apps/web/src/workflows/workspace.tsx","apps/web/src/shell/app-shell.tsx"]
---

# Workflow agent management

Mode: Operate. The approved scope extends the existing HumanOS identity sheet; it does not redesign the app.

## Direction contract

THESIS: Let the workflow owner understand and revoke the exact authority behind a run without leaving the conversation.

OWN-WORLD: Inherit apps/web/DESIGN.md: warm ivory, charcoal, hairline borders, DM Sans, semantic detail rows and 44px controls. No new assets or visual identity.

STORY: Identify the account and verified root, inspect agent scope and expiry, then deliberately enable or revoke it. Pending and unavailable are not active.

FIRST VIEWPORT: The existing right-hand sheet on desktop and scrollable full-width mobile sheet leads with Identity & permissions, account/root, then the current agent state. Technical hashes wrap within the sheet. Exact registration consent is shown in one review section.

FORM: Approved local extension of the existing sheet. No concept-seed applies to this precisely specified component. Preserve workflow selection and use Back/Escape to return focus to the conversation.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
