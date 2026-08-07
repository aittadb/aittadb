# Deployment Guide

Private deployment testing must wait for explicit maintainer approval.

Before creating a private Sites deployment:

1. Generate a signing key with `npm run keys:generate`.
2. Create a fresh Sites project for the fork.
3. Configure D1 binding `DB`.
4. Configure hosted secrets for `ISSUER_URL`, `JWT_KEY_ID`, `JWT_PRIVATE_JWK`, and `ADMIN_EMAILS`.
5. Run `npm run validate`.
6. Deploy privately only after explicit approval.

Do not commit real `.openai/hosting.json` production `project_id` values as part of reusable public templates.
