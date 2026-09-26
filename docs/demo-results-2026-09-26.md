# Fifteen real HumanOS demo attempts — September 26, 2026

Submitted through the signed-in HumanOS UI using real OpenCode/Jev/DeepSeek and the configured Brave adapter. No fixture providers, substituted model responses, policy overrides, external sends, purchases or reservations were used. Sample inputs were supplied where the menu needed specifics.

## Repair follow-up — September 26, 13:41 JST

All fifteen saved workflows now have a real-provider `COMPLETED` execution. This is an **execution result, not fifteen quality passes**. No email, purchase, or restaurant reservation was submitted. Original failures below remain as historical evidence.

### Changes and verification

- Fixed draft-only routing for negated actions such as “do not publish”; these tasks receive content generation without write capabilities.
- Passed the server-authored planned step sequence and research-synthesis meaning into Jev. Policy thresholds and final-confirmation gates were not relaxed.
- Corrected DeepSeek's JSON examples, handled its observed single-key discriminator typo with strict validation, and added one bounded format-recovery request within the existing generation time budget. Text recovery is wrapped with a server-owned output type and still checks schema, length and allowed source URLs. Conflicting keys and extra action fields remain rejected.
- Tightened grounding instructions and source-URL validation, including Markdown link delimiters and balanced URL parentheses. These checks do not prove factual accuracy or guarantee official sources.
- Bounded the desktop sidebar grid and scroll region; long task titles clamp to two lines. Live desktop geometry confirmed the composer stays within the viewport. Responsive regression tests cover 320px and desktop; a live narrow viewport also showed no horizontal overflow.
- Full repository typecheck and serial test suite passed during the repair. Subsequent model fixes passed focused model tests and typecheck. Three chat-layout browser regression tests passed. These automated tests use controlled fixtures; the fifteen application executions use real providers.
- Claude performed a bounded read-only review. Citation formatting and overly absolute evaluator wording were corrected following verification of the findings.

### Latest live evidence

| Demo | Latest execution evidence | Quality qualification |
|---|---|---|
| 1, 5, 6 | Research and generation completed; persisted real-provider attempts | Not individually re-audited for every factual claim |
| 2 | Coworking answer visible, both steps completed, Brave receipt recorded | Missing prices/hours; third space unnamed. Not an adequate three-space comparison yet |
| 3 | Transport research and generation completed | Published excerpts, not live fares or availability |
| 4 | Rainy-day research and generation completed | Needs source/factual review before travel |
| 7 | Product comparison execution completed | Answer explicitly cannot verify three products under ¥5,000; insufficient research, **not a task-quality pass** |
| 8, 9 | Earlier completed runs retained | Earlier source-restriction/invented-detail findings below remain unresolved; not rerun in this batch |
| 10, 11, 13 | Earlier inspected completed drafts retained | Drafts only; no delivery or purchase |
| 12 | Social-post draft completed after routing fix | Nothing published |
| 14 | Manual draft plus automatic one-time and recurring occurrences completed | One generated draft strengthened “pending” into “not yet started”; human factual review still necessary |
| 15 | Digest visibly completed with Brave sources and generated text | Sources include generic landing pages and an April event article; not a reliable current-news digest yet |

One-time scheduling on demo 14 fired at **13:33 JST** and became `COMPLETED`. A separate recurring trial on that same draft fired at **13:37 JST**, advanced to September 27, and was then **paused** through the UI; `Recurring run · paused / No upcoming run` was verified. No ongoing demo recurrence was left active. This verifies the scheduling mechanism with a working draft, not a recurring successful news-research product.

The technology-digest workflow is left open in the app. The UI explicitly reports `Account-owned workflow · No ENS agent linked`; do not present these runs as ENS-authorized agents. Restaurant production integration, an exact approved booking, and confirmed email delivery remain outstanding.

## Original result before repairs

Five executions completed: three acceptable drafts and two outputs with quality issues. Ten requests stopped at planning. All fifteen requests are saved in the app. A saved request or approved plan alone is not a successful run.

| # | Demo | Observed result | Workflow ID |
|---|---|---|---|
| 1 | Free Tokyo activities, September 26–27 | Blocked: Jev alignment | e4aa5d4c-50df-43b7-8295-3b30e88ccbcd |
| 2 | Three Shibuya coworking spaces | Blocked: Jev alignment | 00fd8358-c3a2-4717-a67f-2f5a99f264e0 |
| 3 | Haneda to Shinjuku transport | Blocked: Jev alignment | 2e334633-5de3-470e-8a63-0671793bdf63 |
| 4 | Rainy-day Tokyo itinerary | Blocked: Jev requested human review | 9053ddb3-21b2-4ae6-acf9-f96b7ffeea5e |
| 5 | Vegetarian restaurants near Shinjuku | Blocked: Jev alignment | c149a020-70c4-4308-980b-788a27bff0f2 |
| 6 | Tokyo art/technology events, September 27 | Blocked: Jev alignment | a22cd710-7163-42ef-8ad7-3a68ea9b7f56 |
| 7 | Power banks under 5,000 yen | Blocked: Jev alignment | b7dba7e6-1395-44dd-9ec4-98aab2fc4e9e |
| 8 | Toyota meeting brief | Run complete, both research and generation completed; source-quality failure | 5ad12283-6573-476c-815a-ff9bf135a218 |
| 9 | Professional follow-up draft | Run complete; invented agenda detail | 429f658b-f448-422e-86da-e9b475ca8025 |
| 10 | Short, friendly email rewrite | Run complete; inspected generated text | 36363b86-0272-40bb-8cae-01c8d7ff0e61 |
| 11 | English/Japanese vegetarian inquiry | Run complete; both languages and requested placeholders present | fa8336aa-fc56-41ba-b488-860eb0d1d327 |
| 12 | Three HumanOS social-post drafts | Blocked: Jev alignment | 9369efac-46fd-453e-8cbd-f1c6326cec84 |
| 13 | Seven-day vegetarian meal-plan draft | Run complete; seven days and shopping notes present | a7514536-10ec-4594-ad5c-f4c51587b57d |
| 14 | One-time status-update schedule | Prerequisite draft blocked: Jev alignment; schedule not created | 9ddd9bd2-4a42-4dfa-9f10-a24562bb3555 |
| 15 | Recurring Tokyo technology digest | Prerequisite research plan blocked: Jev alignment; schedule not created | 42a40454-2845-469b-93a4-cb33eed35acd |

Open a saved result at `http://localhost:5173/?workflow=<workflow ID>` while signed in to the same account. Completed outputs were inspected after navigating back to their saved workflow.

## Output evidence and issues

- Demo 8 showed `Run complete`, both steps completed, and `Research web sources / brave:web-search / Provider reference: Recorded receipt`. Its brief cited official Toyota sources but also Wikipedia, ResearchGate and an old GRIN report despite the official-website request. Execution passed; source restriction and relevance did not.
- Demo 9 generated a full follow-up but asserted an agenda containing integration/data considerations and Q&A which was not supplied. Treat that material as unsupported, not ready to send.
- Demo 10: “Hi team, Have you had a chance to review the demo agenda? If you have any feedback, please share it whenever it’s convenient. Thanks!”
- Demo 11 generated English and Japanese versions asking about vegetarian dishes for two guests, with restaurant, date and name placeholders retained. Nothing was sent.
- Demo 13 generated all seven days with breakfast, lunch, dinner and snacks plus shopping/preparation notes. No groceries ordered.
- The repeated planner rejection is a product blocker, not evidence that ordinary research requests are inherently unsafe. Root cause has not been established in this test batch. Do not bypass the checks or blindly lower thresholds.
- Scheduling was not tested in this batch because its two new workflows failed the prerequisite planning step. Previous scheduling evidence does not count as a pass for these two tasks.

## Next fixes indicated by this batch

1. Inspect Jev's selected candidate, graph history and alignment decision on the blocked examples; add regression coverage for the actual defect.
2. Enforce requested source restrictions in search and generation, rather than only including them in the prompt.
3. Prevent unsupported detail in drafts from being stated as fact.
4. Re-run the blocked cases and both scheduling cases after reviewed fixes.
