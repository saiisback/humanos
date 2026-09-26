# HumanOS Linear and Notion MCP

## Intent and scope

Give a nontechnical user two verifiable real-action demos entirely through HumanOS: turn supplied notes into a Linear issue, then save supplied/generated content as a Notion page. No Codex connector may execute on HumanOS's behalf. No restaurant or universal-browser claim is implied.

First release supports one issue or one page per execution. Batch creation, arbitrary MCP servers, deletion, sharing, assignment, comments, and database modifications are excluded. This bounds partial-success and authorization behavior.

## Product journey

1. Connections shows Linear and Notion with real connected, missing, expired and revoked states.
2. Connect the provider to the signed-in HumanOS account. Select a Linear team or a Notion parent page the connection can access.
3. A deterministic intent parser selects the relevant operation. Jev evaluates permitted blocks; DeepSeek only drafts title/body. Ambiguous destination or missing notes causes an in-app question, not a guessed write.
4. Register or select an ENS agent with only the required new capability: `linear.issue.create` or `notion.page.create`, plus applicable draft capability. Existing agents must not silently gain these grants.
5. Present exact provider, workspace, team/parent, title and body once. Confirmation binds the payload hash, account, connection version, workflow version, run and step, and respects expiry/revocation.
6. Execute from the HumanOS backend. Read the created object back and show its provider ID/link as the receipt. Failed or ambiguous outcomes must never display Done.

## Architecture

Add a server-side MCP client using the official TypeScript SDK and Streamable HTTP. Only `https://mcp.linear.app/mcp` and `https://mcp.notion.com/mcp` are allowed. Tool discovery is inspection, not permission: map explicitly reviewed tool schemas into two fixed HumanOS operations. Reject changed schemas rather than dispatch arbitrary tools.

Reuse ConnectorRegistry, connector.call, existing confirmation dispatch, workflow persistence and receipts. Replace the registry's email-only audited-operation branch with an explicit audited-operation table; do not remove its checks. Extend capability schemas, workflow intent bindings, Jev finite candidates and ENS capability mapping together. Use distinct capabilities, never reuse email.send for issue/page writes.

Provider output is untrusted. Validate IDs, URLs, response size and error flags before storing a sanitized output. Remote instructions cannot modify the workflow, grant rights or trigger another tool.

## Authentication and secrets

Linear's official MCP supports API-key/bearer authentication. For the local demonstration use a least-privileged server-side `LINEAR_API_KEY`, account-bound by the existing operator account configuration, and select the Fintrix team only after HumanOS verifies access. Never put this key in Vite variables, repository files or logs.

Notion's hosted MCP requires interactive OAuth. Add account-bound OAuth state, PKCE, single-use expiry and a validated callback; store tokens encrypted server-side with a separately configured encryption key. Follow the provider's published discovery/client-registration requirements; show unsupported configuration as setup-required. Do not substitute a Notion REST integration token and call it hosted MCP.

Connections must show the granted scope and destination before the user authorizes access. Disconnect invalidates subsequent runs and refresh credentials. Credentials from Codex, browser storage or another HumanOS account are never copied.

## Writes, retries and receipts

Persist a dispatch intent before calling a write tool. Use a provider-supported idempotency mechanism only if verified, never assume MCP itself deduplicates. A timeout or crash after dispatch becomes RECONCILIATION_REQUIRED and does not auto-create a second object. Read-back of a known result ID may establish success; searching by similar title cannot prove identity. If the result ID is lost and authoritative reconciliation is unavailable, require manual resolution.

Receipt contains provider, destination, created ID, validated link, request/output hashes and time. Provider creation without successful read-back is pending verification, not a confirmed success. Retrying read-back must not reissue the write. Keep existing model usage reporting; provider/service fees remain unavailable unless documented.

## Verification and acceptance

Test schema rejection, account isolation, destination binding, revoked/expired grants, cancelled/expired confirmation, connection changes, tool errors, response limits, known-ID reconciliation and no duplicate write after timeout. Test UI missing-input and disconnected states. Fixtures are labelled fixtures.

Live acceptance uses HumanOS UI to create one clearly labelled demo issue in a user-selected Linear team, and one demo page beneath a user-selected Notion parent, following in-app confirmation. Retrieve both through HumanOS and retain real IDs/links. No live success claim before this evidence exists. User must authorize the new service connections; no secrets in chat.

## Official references checked 2026-09-27

- Linear authentication/transport: https://linear.app/docs/mcp
- Notion connection and interactive authorization requirements: https://developers.notion.com/guides/mcp/get-started-with-mcp
- Follow the linked Notion custom-client requirements during implementation, before constructing OAuth requests.

## Rollout order

Implement and test shared MCP transport and Linear first. Then implement Notion OAuth and page creation using the same execution boundary. Existing Brave/Resend connectors continue unchanged. No booking work or unrelated cleanup is part of this change.
