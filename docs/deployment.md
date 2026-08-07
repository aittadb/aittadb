# Deployment Guide

Private deployment testing must wait for explicit maintainer approval.

Before creating a private Sites deployment:

1. Generate a signing key with `make generate-local-jwt-key`.
2. Generate an independent administrator key with `make generate-local-admin-access-key` or `npm run admin-key:generate`. The generator writes ignored files with restrictive permissions and does not print key material.
3. Create a fresh Sites project for the fork.
4. Copy `.openai/hosting.example.json` to `.openai/hosting.json` and replace the placeholder with that new Sites project ID.
5. Configure D1 binding `DB`.
6. Configure R2 binding `BUCKET` for AittaDB object storage.
7. Configure hosted values for `ISSUER_URL`, `JWT_KEY_ID`, `JWT_PRIVATE_JWK`, and the storage controls documented in `.env.example`. When enabling administration, set `ADMIN_SUBJECTS` and set the hosted secret `ADMIN_ACCESS_KEY_HASH` to the contents of `.secrets/admin-access-key.sha256`; never upload the plaintext administrator key as that hash secret.
8. Run `npm run validate`.
9. Inspect `dist/.openai/drizzle/` and confirm it contains one generated SQL artifact for every reviewed file in `db/migrations/` plus a non-empty migration journal.
10. Deploy privately only after explicit approval.

Do not commit real `.openai/hosting.json` production `project_id` values as part of reusable public templates.

The build configuration falls back to `.openai/hosting.example.json` so type checking and production-build validation work in a clean checkout and in CI. This fallback does not configure a deployable Sites project. A real deployment still requires the ignored checkout-local `.openai/hosting.json` created in step 4.

Forks must create their own Sites project, D1 database, R2 bucket, JWT signing key, administrator key, and hosted secrets. Do not reuse another deployment's `.openai/hosting.json`, signing key, administrator key, D1 database, or R2 bucket.

## Administrator Bootstrap and Migration

For a fresh deployment, the initial approved deployment can leave administration closed. Sign in at `/session` to create the local user and read its immutable AittaDB UUID, then configure that UUID in `ADMIN_SUBJECTS` together with `ADMIN_ACCESS_KEY_HASH` in a second approved configuration deployment. The browser administrator flow requires the independent plaintext key and issues a secure 15-minute session bound to that UUID. Missing `ADMIN_ACCESS_KEY_HASH` makes administration unavailable with `503`.

For an existing deployment that only has `ADMIN_EMAILS`:

1. Keep the existing exact email entry temporarily and add `ADMIN_ACCESS_KEY_HASH`.
2. Sign in with that account, unlock administration with the independently held key, and confirm the local UUID shown by `/session`.
3. Add that UUID to `ADMIN_SUBJECTS` and deploy the configuration change.
4. Confirm administration with the subject allowlist and independent key.
5. Remove the migrated address from `ADMIN_EMAILS` and deploy again.

Every email-bootstrap session and administrative mutation is audited with redacted, bounded metadata. Remove migrated email entries so they do not remain an unnoticed direct allowlist, but do not claim that UUID allowlisting fixes reassignment: the local UUID is still located through the upstream email, so a reassigned address can resolve to the same subject. The independently held administrator key is the separate factor. Rotate it intentionally with `npm run admin-key:generate -- --force`, replace the hosted hash, distribute the new plaintext key through a separate secure channel, and expect existing administrator sessions to become invalid.

## AittaDB Storage Controls

The initial finite defaults combine records and files and enforce 10,000 items/1 GiB deployment-wide, 1,000 items/100 MiB per local user, and 500 items/50 MiB per local-user/client namespace. Configure lower values for a restricted beta when appropriate. These are AittaDB-enforced abuse ceilings, not Sites quotas or capacity promises. Storage collection pages default to 50 items and reject values above the configured maximum of 100. Per-namespace storage read/write defaults are 120/30 operations per minute.

Set `STORAGE_WRITES_ENABLED=false` as an operational kill switch when new or replacement storage must stop. It returns `503 storage_writes_disabled`, removes write controls from representations, and intentionally leaves authorized reads and deletes available so users can inspect or reduce usage. A configured item/byte ceiling returns `507 storage_limit_exceeded`. Collection usage output contains only the caller's current user/client namespace, never global or cross-client totals.

Rate counters use one-minute windows. A global endpoint-family ceiling is ten times its per-IP ceiling. The counter table fails closed for new keys at 10,000 rows; once-per-minute background cleanup removes at most 500 eligible rows per category and keeps rate-counter rows for five minutes. Monitor sustained `429` responses because cleanup is bounded and depends on durable-route traffic and `waitUntil` execution.

## Public-Beta Limits

As of August 8, 2026, Sites usage is included up to plan-specific public-beta limits. **Persistent D1 database and R2 object storage are provided by ChatGPT Sites, subject to the plan-specific aggregate limits displayed in ChatGPT during the public beta.** Limits apply across all Sites on the account, may change, and can vary for Enterprise and Edu workspaces. ChatGPT displays the limits available to the current plan or workspace and warns as usage approaches them. At a limit, an operator may be unable to add storage, create another Site, or keep a high-usage Site publicly available until usage is reduced. Check [Creating and managing ChatGPT Sites](https://help.openai.com/en/articles/20001339-creating-and-managing-chatgpt-sites) before sizing or publishing a deployment.

OpenAI currently publishes no numerical Sites D1/R2 capacity or allocation, per-object size, row or query, bandwidth or operation, or additional-pricing figures. Treat the limits shown in the Sites experience as authoritative and do not promise fixed AittaDB capacity. The Pro plan's 100 GB [ChatGPT Library](https://help.openai.com/en/articles/20001052/library-for-chatgpt) quota is for ChatGPT Library files and is unrelated to Sites D1/R2.

Sites applies D1 migrations from the packaged deployment artifact. Migration `0004_security_indexes.sql` adds cleanup/origin indexes and scrubs legacy short device user-code display values; only the hash remains durable. A healthy request path must never create or alter tables. After deployment, verify that `/session` and current-session storage work; a missing reserved browser-client migration causes those focused browser operations to fail closed instead of creating schema or client rows at request time.

Dynamic application responses are configured with one-year HSTS including subdomains when production uses an HTTPS issuer. Confirm this and the effective header policy for static assets on the deployed custom domain before release. Also verify exact-origin CORS with active and disabled clients, token CORS, encrypted cursor pagination, concurrent file conflict behavior, each storage ceiling, the write kill switch, rate-limit recovery, migration cleanup, and two-user/two-client isolation. Source tests do not replace those live checks, and the current TASK-075 through TASK-086 revision must not be described as live-verified until that acceptance is complete.
