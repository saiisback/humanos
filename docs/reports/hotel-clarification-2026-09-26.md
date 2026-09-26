# Hotel clarification flow

Implemented in the Browser Use feature worktree, not yet merged into main.

HumanOS collects missing hotel details in the existing saved workflow. It shows known details, asks for up to two missing fields per turn, saves replies as a new version of the same workflow, and offers corrections through Edit stay details. The general new-task composer is hidden during this flow to avoid accidentally saving a reply as an unrelated workflow.

Shared deterministic intake recognizes explicit email/counts, labeled hotel details and Tokyo-relative today/tomorrow stay dates. Relative dates become absolute dates when saved and do not slide across midnight. No guest name, email, budget or occupancy is inferred from unrelated accounts or chat history. Canonical saved data stays out of the displayed request and planner-failure editors.

Hotel requests remain human.input workflows with no booking capabilities. The app clearly says that a supported hotel-booking service is still missing after collection. This is not live hotel booking support; no booking or payment occurred.

## Evidence

- Red/green tests for missing fields, cross-turn preservation, corrections, invalid inputs, timezone/date pinning, labelled relative dates, unknown fields, full confirmation presentation and hidden canonical data.
- Latest schema suite: 65 passed. Latest web suite: 83 passed.
- Backend focused routing/persistence suites: 32 passed, including real isolated PostgreSQL preservation/ownership checks.
- Full workspace pnpm test: exit 0, API 382 passed; latest reviewer fixes additionally covered by the schema/web suites above.
- Web production build and API/web/schema typechecks passed. Existing large-chunk build warning remains.
- Actual browser UI interaction: Playwright desktop and mobile both passed (2 tests), with fixture API responses, same workflow refinement and no external action calls. A second run including editing saved details also passed both projects: changing guests from 1 to 2 preserves dates, name, budget, email and workflow ID.
- Final usability pass reuses the existing warm monochrome form styling, gives inputs full width and 44px minimum height, and collapses known details during questions. Final desktop/mobile rerun: **2 passed**, including expand/collapse, correction and same-workflow checks. Screenshots inspected; no horizontal overflow, lower controls reachable by scrolling. Latest web suite remains **83 passed**.

These test fixtures verify the application flow, not provider availability, live login, reservation success or ENS live acceptance.
