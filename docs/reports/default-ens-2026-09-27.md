# Default ENS task start — September 27, 2026

## Implemented

- Newly created non-legacy workflows persist `authorityRequirement: ens`. Existing records are not silently migrated.
- Authority pinning, account-pinned dispatch and schedule authorization deny account-only execution for these workflows.
- The normal workflow review prepares an ENS scope/expiry review automatically. Its start control explicitly combines registration consent and starting the task. No separate enable-agent visit is required for new executable tasks.
- The start action waits for active, matching authority. Account/task changes, expired reviews, registration failure and revoked/expired authority do not start a run.
- Fixed ENS review selecting the previous active version rather than the newest assembled draft.
- Keys remain backend-managed; Sepolia operator gas and exact-action confirmation are disclosed.

## Verification

Watched new default-policy and newest-draft regression tests fail before fixing them. Focused backend tests then passed (16 tests); default-start UI/orchestration tests passed (7). Runtime authorization tests passed (36), including direct-run/schedule denial and account-pinned dispatch denial.

Full workspace tests passed in the Browser Use worktree (API 397 tests) and the running main checkout (API 315 and web 79). API/web/schema typechecks passed. The different counts reflect the not-yet-merged Browser Use worktree, not skipped production acceptance.

After extending the finality wait and adding a pending-registration resume control, the running main frontend passed all 82 tests and its production build (exit 0). The build reports a non-blocking bundle-size warning. The resume control only checks the existing binding and starts the approved task after authorization; it does not create another registration.

## Live evidence

Through the HumanOS UI, created workflow `845f2c45-9fea-4fbf-a238-7268a1cf8cdb` for a one-sentence welcome draft. The normal start screen displayed `drafts.write`, the configured parent, Sepolia, backend custody, gas implications and expiry. After explicit user approval, clicked its start action.

The database recorded agent `mdf2116e8daa8e472.rc151de4cc3d262f2.test-humanos.eth`. A read-only RPC check verified chain ID 11155111 and a successful receipt for transaction `0x99fb13479d46bd06f788d968b14d2c93241ab56f9cd372d2bc71f94f488757f6`, block 11787314. At that observation the finalized head was 11787241, so the binding remained pending. This proves a successful transaction, not yet completed draft execution or finalized authorization.

An earlier draft-workflow binding also has a successful Sepolia transaction: `0xe420fc9109c48329582f53be9256f122185d9531e3c62f5dbc1ab9e4dfefd0f1`, block 11786430. No registration was inferred solely from a configured badge.

## Still incomplete

TableCheck submission is not integrated or claimed as passing. The Browser Use worktree retains a known material/dispatch race regression, explicitly marked expected failure; its production policy list remains empty. Guest full name, phone number and allergy details have not been supplied. The user's permission to test did not supply those missing values. No restaurant reservation or additional email has been submitted.
