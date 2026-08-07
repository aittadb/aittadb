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

Sites applies D1 migrations from the packaged deployment artifact. A healthy request path must never create or alter tables. After deployment, verify that `/session` and current-session storage work; a missing reserved browser-client migration causes those focused browser operations to fail closed instead of creating schema or client rows at request time.
