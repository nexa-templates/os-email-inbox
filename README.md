# Email Inbox

Standalone Cloudflare application with customer-owned data.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nexa-templates/os-email-inbox)

## Run and deploy

Install dependencies using the included lockfile, run `npm run build`, then `npm run deploy`. Wrangler provisions the declared resources. No Nexa account or API key is required for the default configuration.

## Access

Protect the application hostname with Cloudflare Access. Configure `ACCESS_ISSUER`, `ACCESS_AUD` and `APP_ORIGIN`. The Worker also verifies signed tokens and rejects alternate hostnames.

`PREVIEW_MODE=true` is only for an isolated public sample deployment with no customer data or live services. Real installations use `false`.
## Email

Default `EMAIL_PROVIDER=cloudflare`: configure your own Email Routing rules to this Worker and list allowed recipients/senders in `EMAIL_ADDRESSES`. Enable sending for your domain/account. Incoming MIME and attachments are stored in the customer-owned Mailbox SQLite Durable Object before delivery completes. Unknown sends are retained without automatic retry.

For Nexa OS, configure Email in the project Services tab, create an email key, set `EMAIL_PROVIDER=os` and `OS_SERVICE_URL` to the displayed endpoint, and save that key as the `OS_SERVICE_KEY` Worker secret. The OS supplies only this project’s assigned addresses. With Cloudflare email, route incoming addresses to this Inbox Worker; with Nexa email, messages arrive through the durable queue.

Optional `EMAIL_PROVIDER=nexa`: register this app as a separate Nexa service installation, assign receiving aliases to it, set `NEXA_INSTALLATION_ID`, and install an email-only key scoped to that installation as `NEXA_SERVICE_KEY`. The inbox acknowledges queued mail only after durable local storage. Never put any service key in client code.

## Source

Adapted from [email-inbox](https://github.com/nexa-templates/email-inbox/tree/ee2e105631a32e1a9f9826a00b1d69717f5b44ba) at `ee2e105631a32e1a9f9826a00b1d69717f5b44ba`. Original license files are retained. These source files are ordinary Wrangler applications; no Nexa manifest is required.
