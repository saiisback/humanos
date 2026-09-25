# HumanOS: remaining live-demo setup

Put credentials only in the repository's private `.env`, never in chat or Git. Keep the existing values; add or update only the entries below. Restart the relevant local service after configuration changes. A configured key does not prove a successful request.

## Already demonstrated

- `OPENCODE_API_KEY`: keep the existing key. Real Jev planning and DeepSeek generation completed in the app. No separate Jev or DeepSeek key is needed for this OpenCode setup.
- JAW login: the test browser already has a valid HumanOS session.
- Flue: running locally; its workflow route was restored by restarting the outdated process. No new Flue account is needed for this local setup.

## Search and email

| Entry | What to provide | Where |
| --- | --- | --- |
| `BRAVE_SEARCH_API_KEY` | A Brave Search API key with search access | [Brave Search API](https://brave.com/search/api/) and its linked developer dashboard |
| `RESEND_API_KEY` | An API key allowed to send email; prefer a sending-only/domain-restricted key | [Resend API key management](https://resend.com/docs/dashboard/api-keys/introduction) |
| `RESEND_FROM_EMAIL` | The actual sender address authorized by Resend, not an arbitrary Gmail address | [Verify a domain you control](https://resend.com/docs/dashboard/domains/introduction) |
| `CONNECTOR_ACCOUNT_ID` | HumanOS's authenticated account ID in `chainId:address` format, including its chain prefix; not just the wallet address | The app's account identity. We will verify the exact value before binding credentials. Never put a private key here. |

For the email demonstration, also choose a recipient you control and the message to send. Provider acceptance and inbox delivery are separate checks. The final email preview must be approved before sending.

## Real restaurant booking

Provide the restaurant or booking-page URL, date, local time/timezone, party size, and any budget/deposit constraint. Supply required contact details only when the actual site and data use are clear.

- A reviewed production site recipe is still required. Adding a browser flag alone does not enable arbitrary bookings.
- Once a recipe is installed, `HUMANOS_BROWSER_DRIVER=local-chromium` opts into the local browser runner.
- `HUMANOS_BROWSER_PROFILE_DIR` is optional and must point to a dedicated HumanOS profile, not your existing Helium/Chrome profile.
- `HUMANOS_BROWSER_HEADLESS=false` makes the dedicated runner visible for a demo.
- Login, CAPTCHA or site-specific authorization may require your direct input.
- The current runner supports tightly bounded form-urlencoded submissions; sites with hidden tokens, complex payment widgets or other protocols require additional reviewed support.
- Availability and final details must be checked live. No reservation is claimed until the provider returns verifiable confirmation. Submission or payment requires your exact final approval.

## ENSv2

Keep the existing ENS configuration; do not create or replace keys blindly. New workflows are not yet bound to ENS agent permissions or publishing ENS receipts. This is an implementation gap, not something another API key will fix. The account-owned workflow UI says “No ENS agent linked” until that integration exists.

## Demo order after setup

1. Draft text using real Jev + DeepSeek; reload to confirm saved output.
2. Live search with real source URLs, then DeepSeek's sourced response.
3. Prepare an email, inspect exact recipient/sender/body, confirm once, inspect provider receipt and recipient inbox.
4. Prepare a real reservation, check current availability and terms, stop for final confirmation, then verify the site's receipt if approved.
5. Run one harmless scheduled draft; verify its recorded outcome. Keep recurring external actions paused until explicitly configured.

Missing credentials, rejected planning, cancellations, changed booking details, expired authorization and uncertain provider outcomes must remain visibly blocked—not reported as completed.
