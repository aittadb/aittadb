# Deployment Guide

Private deployment testing must wait for explicit maintainer approval.

Before creating a private Sites deployment:

1. Generate a signing key with `make generate-local-jwt-key`.
2. Create a fresh Sites project for the fork.
3. Copy `.openai/hosting.example.json` to `.openai/hosting.json` and replace the placeholder with that new Sites project ID.
4. Configure D1 binding `DB`.
5. Configure R2 binding `BUCKET` for AittaDB object storage.
6. Configure hosted values for `ISSUER_URL`, `JWT_KEY_ID`, `JWT_PRIVATE_JWK`, the privacy notice, and the storage controls documented in `.env.example`. Leave `ADMIN_SUBJECTS` empty until the intended administrator has signed in once.
7. Run `npm run validate`.
8. Inspect `dist/.openai/drizzle/` and confirm it contains one generated SQL artifact for every reviewed file in `db/migrations/` plus a non-empty migration journal.
9. Deploy privately only after explicit approval.

Do not commit real `.openai/hosting.json` production `project_id` values as part of reusable public templates.

The build configuration falls back to `.openai/hosting.example.json` so type checking and production-build validation work in a clean checkout and in CI. This fallback does not configure a deployable Sites project. A real deployment still requires the ignored checkout-local `.openai/hosting.json` created in step 3.

Forks must create their own Sites project, D1 database, R2 bucket, JWT signing key, and hosted secrets. Do not reuse another deployment's `.openai/hosting.json`, signing key, administrator allowlist, D1 database, or R2 bucket.

## Administrator Bootstrap and Migration

For a fresh deployment, leave administration closed while `ADMIN_SUBJECTS` is empty. Sign in at `/session` to create the local user and read its immutable deployment-local AittaDB UUID. Add that canonical UUIDv4 to `ADMIN_SUBJECTS` through Sites configuration and deploy the configuration change. The next request from that same trusted Sites session can open `/admin/clients` directly; no separate administrator password, key, header, or unlock cookie exists.

For an existing deployment using the removed `ADMIN_EMAILS` or `ADMIN_ACCESS_KEY_HASH` settings:

1. Before upgrading, sign in with each intended administrator and record only the local UUID shown by `/session`.
2. Configure those UUIDs in `ADMIN_SUBJECTS` and deploy the new source and configuration together.
3. Confirm that an allowlisted signed-in account can open `/admin/clients` and an unlisted account receives a generic denial.
4. Remove the obsolete `ADMIN_EMAILS` and `ADMIN_ACCESS_KEY_HASH` hosted values; the new source never reads them.

Administrative mutations are audited with bounded action data and hashed actor/client references. Do not claim that UUID allowlisting fixes reassignment: AittaDB still locates the local UUID through the upstream email, so a reassigned address can resolve to the same subject. Until Sites supplies a stable upstream subject or AittaDB gains a stronger account-migration contract, operators must treat that as a material residual administrator-takeover risk and keep the allowlist narrow.

## Privacy Notice Configuration

The operator of each published AittaDB deployment is the controller for that deployment's Hosted Data and must review the [baseline Privacy Policy](privacy.md), applicable law, configured OAuth clients, purposes, retention, and contact details before publishing. OpenAI hosts and processes Sites Hosted Data under the applicable [ChatGPT Sites Data Processing Addendum](https://openai.com/policies/chatgpt-sites-data-processing-addendum/) or the operator's organization agreement. Do not claim a fixed processing location: [Sites documentation](https://help.openai.com/en/articles/20001339-creating-and-managing-chatgpt-sites) currently says deployed Sites, D1/R2 data, artifacts, and logs do not support data residency at launch.

Configure only public values in `PRIVACY_CONTROLLER_NAME`, `PRIVACY_CONTROLLER_IDENTIFIER`, `PRIVACY_CONTACT_NAME`, `PRIVACY_CONTACT_EMAIL`, `PRIVACY_CONTACT_PHONE`, and `PRIVACY_CONTACT_ADDRESS`; explicit values take precedence and blanks are not rendered. Do not put credentials or private addresses in these fields. No personal defaults belong in source control.

When required controller/contact data is incomplete, `/privacy` resolves the first canonical UUID in `ADMIN_SUBJECTS` through the local-user repository and uses only its last stored email plus optional display name. It never displays that UUID, the allowlist, or another user field. This fallback works only after that administrator has signed in, does not prove that the address remains current or verified, and still carries the documented email-reassignment risk. If neither explicit configuration nor the fallback yields a usable controller and contact, `/privacy` returns a generic `503` rather than an incomplete notice.

Before publication, request `/privacy` with both `Accept: text/html` and `Accept: application/vnd.aittadb+json; version=0.1`; verify the same policy and links, escaped intended contact values, and no identifier or secret leakage. Repeat this review whenever the operator, clients, purposes, retention, Sites terms/DPA, or contact configuration changes.

## AittaDB Storage Controls

The initial finite defaults combine records and files and enforce 10,000 items/1 GiB deployment-wide, 1,000 items/100 MiB per local user, and 500 items/50 MiB per local-user/client namespace. Configure lower values for a restricted beta when appropriate. These are AittaDB-enforced abuse ceilings, not Sites quotas or capacity promises. Storage collection pages default to 50 items and reject values above the configured maximum of 100. Per-namespace storage read/write defaults are 120/30 operations per minute.

Set `STORAGE_WRITES_ENABLED=false` as an operational kill switch when new or replacement storage must stop. It returns `503 storage_writes_disabled`, removes write controls from representations, and intentionally leaves authorized reads and deletes available so users can inspect or reduce usage. A configured item/byte ceiling returns `507 storage_limit_exceeded`. Collection usage output contains only the caller's current user/client namespace, never global or cross-client totals.

Rate counters use one-minute windows. A global endpoint-family ceiling is ten times its per-IP ceiling. The counter table fails closed for new keys at 10,000 rows; once-per-minute background cleanup removes at most 500 rows per category, oldest eligibility timestamp first with a deterministic `rowid` tie-breaker, and keeps rate-counter rows for five minutes. Monitor sustained `429` responses because cleanup is bounded and depends on durable-route traffic and `waitUntil` execution.

## Public-Beta Limits

As of August 8, 2026, Sites usage is included up to plan-specific public-beta limits. **Persistent D1 database and R2 object storage are provided by ChatGPT Sites, subject to the plan-specific aggregate limits displayed in ChatGPT during the public beta.** Limits apply across all Sites on the account, may change, and can vary for Enterprise and Edu workspaces. ChatGPT displays the limits available to the current plan or workspace and warns as usage approaches them. At a limit, an operator may be unable to add storage, create another Site, or keep a high-usage Site publicly available until usage is reduced. Check [Creating and managing ChatGPT Sites](https://help.openai.com/en/articles/20001339-creating-and-managing-chatgpt-sites) before sizing or publishing a deployment.

OpenAI currently publishes no numerical Sites D1/R2 capacity or allocation, per-object size, row or query, bandwidth or operation, or additional-pricing figures. Treat the limits shown in the Sites experience as authoritative and do not promise fixed AittaDB capacity. The Pro plan's 100 GB [ChatGPT Library](https://help.openai.com/en/articles/20001052/library-for-chatgpt) quota is for ChatGPT Library files and is unrelated to Sites D1/R2.

Sites applies D1 migrations from the packaged deployment artifact. Migration `0004_security_indexes.sql` adds cleanup/origin indexes and scrubs legacy short device user-code display values; only the hash remains durable. Migration `0005_admin_submission_results.sql` adds hash-only, expiring one-time administrator submission/result gates and stores no result or client-secret plaintext. A healthy request path must never create or alter tables. After deployment, verify that `/session` and current-session storage work; a missing reserved browser-client migration causes those focused browser operations to fail closed instead of creating schema or client rows at request time.

Dynamic application responses are configured with one-year HSTS including subdomains when production uses an HTTPS issuer. Confirm this and the effective header policy for static assets on the deployed custom domain before release. Also verify exact-origin CORS with active and disabled clients, token CORS, encrypted cursor pagination, concurrent file conflict behavior, each storage ceiling, the write kill switch, rate-limit recovery, migration cleanup, and two-user/two-client isolation. For administration, complete create, refresh, enable, disable, confidential-secret rotation, grant revocation, stale-result replay, and secret-disappearance checks with the allowlisted live Sites identity. Source tests do not replace those live checks and must not be described as live verification.
