# Security Policy

AittaDB is experimental, security-sensitive application-backend software. Report vulnerabilities privately to Jaakko Heusala <jheusala@iki.fi>.

Do not file public issues that include working exploits, private keys, client secrets, refresh tokens, access tokens, authorization codes, device codes, cookies, or PII.

Production deployments must configure `ISSUER_URL`, `JWT_KEY_ID`, `JWT_PRIVATE_JWK`, `ADMIN_EMAILS`, D1 binding `DB`, and R2 binding `BUCKET` through Sites secrets and bindings. Production deployment requires explicit maintainer approval.

The deployed application always uses the single ChatGPT Sites header identity provider. There is no production configuration, binding, or environment mode for a mock user; synthetic identities are injected only by test code that is outside the Worker module graph.

Application storage is available only through scoped operations bound to both the access token's immutable local user UUID and OAuth client ID. The same checks apply whether a resource is represented as hypermedia JSON or HTML. Collection file creation generates its logical key server-side; item updates use only the validated URL key; all R2 physical keys are generated internally.

AittaDB must never expose generic SQL/D1 access, internal authentication tables, physical R2 keys, environment values, bindings, private JWK fields, hosted secrets, or another user/client namespace. The reserved current-browser-session client is internal, non-administrable, and invalid for external OAuth flows. The public `/statistics` resource is limited to one aggregate local-identity count and must not expose identity rows, personal fields, client relationships, or storage metadata.

One-time OAuth transitions are atomic compare-and-set operations in D1. Bearer consumers reject ID tokens, refresh-token reuse revokes its family, and revocation is bound to the owning client. Browser mutations require both CSRF validation and an independently verified same-origin signal; a missing `Origin` fails closed. Multipart bodies are bounded while streaming, regardless of `Content-Length`.

File operations compensate isolated D1/R2 failures, but the services do not share a transaction. A simultaneous persistent failure in both a primary write and its compensation can require private operator repair; public responses must remain generic and never reveal object keys, bindings, or backend errors.
