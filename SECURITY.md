# Security Policy

Sites Auth Broker is experimental security-sensitive authentication software. Report vulnerabilities privately to Jaakko Heusala <jheusala@iki.fi>.

Do not file public issues that include working exploits, private keys, client secrets, refresh tokens, access tokens, authorization codes, device codes, cookies, or PII.

Production deployments must configure `ISSUER_URL`, `JWT_KEY_ID`, `JWT_PRIVATE_JWK`, `ADMIN_EMAILS`, and D1 binding `DB` through Sites secrets and bindings. Production deployment requires explicit maintainer approval.
