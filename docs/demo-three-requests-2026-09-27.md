# HumanOS: three-request demo evidence

Recording target: three minutes, using real HumanOS screens. This document is a preparation ledger, not a claim that the three executions have succeeded. Update outcomes after observing them. Do not publish keys, session tokens, private user identifiers, or unrelated Linear issues in footage.

## Recording outline

| Time | Screen | Story |
| --- | --- | --- |
| 0:00–0:20 | HumanOS home | One request becomes a saved workflow. Jev evaluates bounded steps; DeepSeek writes content. |
| 0:20–1:00 | Web-search request and actual output | Search and writing are separate steps. Show real source links and the search agent's scopes. |
| 1:00–1:40 | Welcome-message request and actual output | A normal writing request needs only drafts.write. Show output and reported usage. |
| 1:40–2:20 | Linear exact confirmation and receipt | Show the actual title, description, Fintrix destination, confirmation, and verified issue link. Do not show success unless read-back succeeds. |
| 2:20–3:00 | Agent identities and transactions | Show three distinct names, scoped permissions and expiry. ENS makes identity and recorded authority inspectable; it does not prove content is truthful. |

Edit out chain waiting time and label any time cut. The three-minute edit is not a claim that chain finality took three minutes. API cost comparisons are equivalent-token estimates, not measured competing runs or subscription savings.

## Upgrade

User explicitly approved activating the replacement namespace and recreating demo agents. Old canonical agent bindings are no longer valid under the replacement registry. No old external task is to be replayed.

- New registrar: `0x03544810e852482aa6406aba668c1d4ccdf0aca2`.
- New registry: `0xdf6b9d43b1d2e6b7a4aa537d77ebb02dc841d851`.
- [Deployment transaction](https://sepolia.etherscan.io/tx/0xc292a385152224df17e8aea0b65f13b765407bef96b27851d86f08fd11debadd).
- [Parent registry switch](https://sepolia.etherscan.io/tx/0x7b5203d3a3362e6ec5c4abbd14242a8930ad84c988734c0fcc775c6877707fa9).
- Live CAPABILITY_MASK read: 32767 (`0x7fff`), including Linear at bit 14 and unchanged original bits.

## Three agents

### Web search

- [Local workflow](http://localhost:5173/?workflow=c1e8f2a6-9675-42b9-b10e-94d3156f1f34).
- ENS name: `m29ff6aeb38b85c2e.rc151de4cc3d262f2.test-humanos.eth`.
- Scopes: `drafts.write`, `web.search`.
- [Registration transaction](https://sepolia.etherscan.io/tx/0x8ee073b37d5cedee9a2196962ba243221467da45b1d8cb10663b8df54d185707).
- Execution: subsequent live run completed in HumanOS after finality. Brave returned real search results and DeepSeek synthesized an answer. Quality limitation: only one returned source was official; the response flags that the remaining official-source requirement is unmet. Do not describe this as a fully validated travel recommendation.

### Normal message

- [Local workflow](http://localhost:5173/?workflow=e17d8a5c-ec31-41ce-99f1-ca0e721102f4).
- ENS name: `meaa72cc71794649f.rc151de4cc3d262f2.test-humanos.eth`.
- Scope: `drafts.write` only; no email is sent.
- [Root registration](https://sepolia.etherscan.io/tx/0xf29459b7f983f2f32e65d93c6e60fa817bad6d7e874086eefcc568e14404456a).
- [Agent registration](https://sepolia.etherscan.io/tx/0x36d01cb6f2ea5845252b528a49a216b152269f28787dff7a2cb7b2597e9c2762).
- Execution: fresh-session rerun completed under ENS authority (run `0xd3730e78a46b59b618a3730ca532e1e029f3ccab42db53fd0a3ffb3cebd5c7a0`). Earlier run failed AUTHORIZATION; no security checks were disabled for the rerun.

### Linear issue

- [Local workflow](http://localhost:5173/?workflow=8d96fcf2-09be-4688-946a-c7f1dab0e3a9).
- ENS name: `mc4f570cbac10b753.rc151de4cc3d262f2.test-humanos.eth`.
- Scopes: `drafts.write`, `linear.issue.create`.
- [Agent registration](https://sepolia.etherscan.io/tx/0xca80de2b3851fd20805847626c624f285e332d249bf62609dfbba4b37cd4c9da).
- HumanOS connected to workspace `fintrix`, team `Fintrix` via its official Linear MCP adapter.
- Jev initially rejected the confirmation step's alignment. Clarifying that the user wants exact confirmation before creation produced the intended three-step plan without lowering thresholds.
- Execution: completed through HumanOS after refreshing the expired confirmation and confirming the exact title/body and Fintrix destination. Provider read-back verified [FIN-100 — HumanOS demo test](https://linear.app/fintrix-finance/issue/FIN-100/humanos-demo-test). Do not rerun this workflow to obtain footage; it would create another issue.

Localhost links work on the demo computer only; public transaction links are available to judges. Agent expiry is temporary; footage must state this and preserve transaction links for historical evidence.

## Local regression evidence

- Full `pnpm test` with isolated TEST_DATABASE_URL exited 0; API: 427 passed, 3 skipped.
- Full `pnpm typecheck` exited 0.
- These tests do not substitute for live provider success.

## Recording prerequisite

The user signed into Helium. Native controls showed QuickTime's File → New Screen Recording disabled after launch, so recording has not started. User handoff is required to start macOS recording. No video file exists yet. Record completed results without replaying the Linear external write.
