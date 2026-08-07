# Deployment Guide

Private deployment testing must wait for explicit maintainer approval.

Before creating a private Sites deployment:

1. Generate a signing key with `make generate-local-jwt-key`.
2. Create a fresh Sites project for the fork.
3. Copy `.openai/hosting.example.json` to `.openai/hosting.json` and replace the placeholder with that new Sites project ID.
4. Configure D1 binding `DB`.
5. Configure R2 binding `BUCKET` for AittaDB object storage.
6. Configure hosted secrets for `ISSUER_URL`, `JWT_KEY_ID`, `JWT_PRIVATE_JWK`, and `ADMIN_EMAILS`.
7. Run `npm run validate`.
8. Inspect `dist/.openai/drizzle/` and confirm it contains one generated SQL artifact for every reviewed file in `db/migrations/` plus a non-empty migration journal.
9. Deploy privately only after explicit approval.

Do not commit real `.openai/hosting.json` production `project_id` values as part of reusable public templates.

The build configuration falls back to `.openai/hosting.example.json` so type checking and production-build validation work in a clean checkout and in CI. This fallback does not configure a deployable Sites project. A real deployment still requires the ignored checkout-local `.openai/hosting.json` created in step 3.

Forks must create their own Sites project, D1 database, R2 bucket, JWT signing key, and hosted secrets. Do not reuse another deployment's `.openai/hosting.json`, signing key, D1 database, or R2 bucket.

## Public-Beta Limits

As of August 8, 2026, Sites usage is included up to plan-specific public-beta limits. **Persistent D1 database and R2 object storage are provided by ChatGPT Sites, subject to the plan-specific aggregate limits displayed in ChatGPT during the public beta.** Limits apply across all Sites on the account, may change, and can vary for Enterprise and Edu workspaces. ChatGPT displays the limits available to the current plan or workspace and warns as usage approaches them. At a limit, an operator may be unable to add storage, create another Site, or keep a high-usage Site publicly available until usage is reduced. Check [Creating and managing ChatGPT Sites](https://help.openai.com/en/articles/20001339-creating-and-managing-chatgpt-sites) before sizing or publishing a deployment.

OpenAI currently publishes no numerical Sites D1/R2 capacity or allocation, per-object size, row or query, bandwidth or operation, or additional-pricing figures. Treat the limits shown in the Sites experience as authoritative and do not promise fixed AittaDB capacity. The Pro plan's 100 GB [ChatGPT Library](https://help.openai.com/en/articles/20001052-library-for-chatgpt) quota is for ChatGPT Library files and is unrelated to Sites D1/R2.

Sites applies D1 migrations from the packaged deployment artifact. A healthy request path must never create or alter tables. After deployment, verify that `/session` and current-session storage work; a missing reserved browser-client migration causes those focused browser operations to fail closed instead of creating schema or client rows at request time.
