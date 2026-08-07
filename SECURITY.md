# Security Policy

AittaDB is experimental, security-sensitive application-backend software. Report vulnerabilities privately to Jaakko Heusala <jheusala@iki.fi>.

Do not file public issues that include working exploits, private keys, client secrets, refresh tokens, access tokens, authorization codes, device codes, cookies, or PII.

Production deployments must configure `ISSUER_URL`, `JWT_KEY_ID`, `JWT_PRIVATE_JWK`, `ADMIN_EMAILS`, D1 binding `DB`, and R2 binding `BUCKET` through Sites secrets and bindings. Production deployment requires explicit maintainer approval.

Application storage is available only through scoped operations bound to both the access token's immutable local user UUID and OAuth client ID. AittaDB must never expose generic SQL/D1 access, internal authentication tables, physical R2 keys, environment values, bindings, private JWK fields, hosted secrets, or another user/client namespace. The reserved current-browser-session client is internal, non-administrable, and invalid for external OAuth flows.
