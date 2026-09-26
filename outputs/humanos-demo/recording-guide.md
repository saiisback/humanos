# HumanOS recording guide

## Three-minute sequence

Record at normal speed with voice narration. ETHGlobal requests 2–4 minutes, at least 720p and audio without music. Close key dashboards and unrelated inbox tabs. Disable notifications. Do not speed up the video. If you cut waiting time, label the cut rather than implying instant execution.

| Time | Show | Say |
| --- | --- | --- |
| 0:00–0:20 | Slide 1 | HumanOS makes everyday AI automation accessible to people who do not want to assemble a technical stack. Describe the task, save a workflow, and keep control over external actions. |
| 0:20–0:40 | Slide 2 | Our goal is lower model spend through reusable deterministic steps. Jev evaluates the permitted blocks, connectors execute them, and DeepSeek writes content. ENS gives each agent a scoped identity. |
| 0:40–1:10 | Welcome draft, completed output, usage | This simple writing task needs only drafts.write. Here is its actual output and reported model usage. The comparison is an equivalent-token API estimate, not a benchmark or subscription saving. |
| 1:10–1:45 | Web research, one source, agent permissions | Research uses separate search and writing steps. We can inspect the source and see that this agent has web.search and drafts.write permissions. Unverified information stays labelled. |
| 1:45–2:25 | Linear workflow, completed receipt, FIN-100 | For an external action, HumanOS asks for exact confirmation. This run created a real issue, and provider read-back verified FIN-100. Opening the link shows the result in Linear. |
| 2:25–2:50 | ENS agent name, scope, expiry, registration transaction | Each workflow agent has its own ENS name and limited authority. This Sepolia transaction proves registration. Execution receipts and their onchain publication have separate statuses. |
| 2:50–3:00 | HumanOS or slide 1 | Our goal is useful automation with less setup and lower model overhead, while keeping identity, permissions and execution evidence inspectable. |

Use completed runs for the recording to avoid chain-finality delays. If you also show a new request, create it before recording and clearly distinguish it from historical proof. Do not rerun the existing Linear workflow merely for footage: that can create a duplicate issue.

## Copy-paste prompts

### 1. Normal message

```text
Write a friendly two-sentence welcome message for a new HumanOS user. Draft only; do not send anything.
```

### 2. Web research

```text
Research three free things to do in Tokyo, with official source links. Keep the answer concise and flag any uncertain opening hours or admission details. Do not make a booking.
```

The recorded search returned only one official source. Show its caveat instead of claiming the entire answer meets the official-source requirement.

### 3. Linear issue (only if deliberately creating one new issue)

```text
Create one Linear issue in the connected Fintrix team. Title: HumanOS judges demo. Description: Verify that HumanOS can create a real issue through its scoped ENS agent and return the issue link. Show me the exact title, description and destination for confirmation before creating it. Do not assign it to anyone or add a due date.
```

This is a new request, not evidence that it has already succeeded. Review and approve once. Show success only after HumanOS returns a verified issue link.

## Existing completed workflows

- [Welcome draft](http://localhost:5173/?workflow=e17d8a5c-ec31-41ce-99f1-ca0e721102f4)
- [Web research](http://localhost:5173/?workflow=c1e8f2a6-9675-42b9-b10e-94d3156f1f34)
- [Linear workflow](http://localhost:5173/?workflow=8d96fcf2-09be-4688-946a-c7f1dab0e3a9)
- [Actual Linear issue FIN-100](https://linear.app/fintrix-finance/issue/FIN-100/humanos-demo-test)

Localhost links work only on the demo computer. Linear may require workspace access.

## Public ENS proof links

- Draft: `meaa72cc71794649f.rc151de4cc3d262f2.test-humanos.eth` — [registration](https://sepolia.etherscan.io/tx/0x36d01cb6f2ea5845252b528a49a216b152269f28787dff7a2cb7b2597e9c2762)
- Research: `m29ff6aeb38b85c2e.rc151de4cc3d262f2.test-humanos.eth` — [registration](https://sepolia.etherscan.io/tx/0x8ee073b37d5cedee9a2196962ba243221467da45b1d8cb10663b8df54d185707)
- Linear: `mc4f570cbac10b753.rc151de4cc3d262f2.test-humanos.eth` — [registration](https://sepolia.etherscan.io/tx/0xca80de2b3851fd20805847626c624f285e332d249bf62609dfbba4b37cd4c9da)

Registration is not receipt publication. Search receipt recovery is pending at preparation time. Do not claim all task data is onchain or that an ENS name prevents AI from making false statements.

## Optional email cutaway

Show the previously received email, without sending another. Search Gmail for `subject:"HumanOS live email test"` before recording, open only that message, and avoid exposing unrelated mail. This can replace 10 seconds of the final section.

## What to claim

- Demonstrated: draft generation, live web research, verified Linear issue creation and Sepolia agent registration.
- Earlier evidence: delivered test email. Show the received message if using that claim.
- Do not present restaurant booking as complete. A general browser harness does not guarantee every booking site works.
- Positioning: “We are building a cost-conscious agent harness for non-technical users, in the same broad category as tools such as Hermes.” Do not claim competitive superiority without a measured comparison.
- Savings: explain the architecture and show measured tokens plus labelled price estimates. No established $10–$20 plan or universal savings percentage is claimed.
