# Self-Hosting Limitations

The default upstream identity adapter receives the result of ChatGPT sign-in only inside the trusted ChatGPT Sites runtime. A generic Cloudflare Worker or other host must not trust browser-sent `oai-authenticated-user-*` headers.

Self-hosted deployments must implement `UpstreamIdentityProvider` for a trusted server-side identity source and inject it while composing the application. They must not reuse the Sites header provider at an untrusted edge or add environment-selected mock users. Update `AGENTS.md`, OpenAPI documentation, tests, and this file in the same task.

The current user repository still locates an AittaDB identity by upstream email because ChatGPT Sites documents no stable subject. Merely replacing the header parser does not remove email-change or reassignment risk. A self-hosted identity source with a stable subject requires a deliberate user-mapping schema and migration change; do not silently place a foreign subject in the email field.

AittaDB storage also depends on D1-like SQL durability and R2-like object storage. A self-hosted adapter must preserve the same ownership model: JSON records and file metadata keyed by immutable AittaDB user UUID and OAuth client ID, file bytes behind server-generated object keys, and no trust in caller-supplied physical storage paths.

The SQL adapter must preserve affected-row-gated one-time OAuth transitions, atomic rate-counter upserts, conditional deployment/user/user-client storage ceilings, deterministic cursor ordering, exact-origin lookup on active clients, and bounded cleanup. The object adapter must preserve copy-on-write replacement and bounded compensation. If its database and object store do not share a transaction, the same simultaneous-failure repair limitation applies.

Self-hosted operators must configure their own finite storage ceilings and write kill switch; AittaDB's defaults are not claims about the replacement provider's capacity. They must also provide HTTPS/HSTS at the effective public edge, streaming body limits, exact CORS behavior, and immutable local UUID administrator subjects. Administration must remain bound to the current trusted upstream session plus that subject allowlist. UUID allowlisting still inherits reassignment risk until the replacement identity mapping has a stable subject.

AittaDB remains independent software, not an OpenAI product. Current releases are source-available under FSL-1.1-MIT and each released version converts to the MIT License two years after publication, regardless of hosting environment.
