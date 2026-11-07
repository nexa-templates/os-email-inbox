# Email inbox template

This repository is a working shared inbox for Nexa organization aliases. Preserve the clear folder/conversation layout and the original Nexa identity.

- Start with README.md. The Worker and customer-owned SQLite Durable Object are in src/; index.html, styles.css, mail.css and app.js provide the interface.
- Keep sample data identified as sample until real mailbox data is connected. Do not present local demo actions as successful sending or synchronization.
- Nexa Templates publishes with `PREVIEW_MODE="true"`. Keep preview mail in each browser, block all real mailbox APIs and cron work, and never call Nexa services from preview. Imported production mailboxes explicitly set this flag to `"false"` and retain protected sign-in. Use the published Worker URL; no GitHub Pages.
- Keep protected Nexa sign-in and verify signed identities. Plain headers never grant access. All authorized project users share this inbox. Save incoming MIME transactionally before acknowledging. Preserve immutable send IDs and uncertain-send records. Never commit tokens, private messages, or customer information to this public upstream.
- Imported projects should use their own Cloudflare account, Worker name, resources, and secrets. Keep upstream history for future merges.
- Run the build, bun test, JavaScript syntax checks, and inspect light/dark desktop/mobile browser layouts after changes. Keep tests for persistence, access, capacity and ambiguous delivery; never send real email in automated tests.

This standalone version uses Cloudflare Access. Production must fail closed without its issuer, audience and application origin. Local sample tests run with PREVIEW_MODE=true; signed-token tests cover the production gate. Never enable preview mode for customer data or live email.
