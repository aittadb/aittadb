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
8. Deploy privately only after explicit approval.

Do not commit real `.openai/hosting.json` production `project_id` values as part of reusable public templates.

Forks must create their own Sites project, D1 database, R2 bucket, JWT signing key, and hosted secrets. Do not reuse another deployment's `.openai/hosting.json`, signing key, D1 database, or R2 bucket.
