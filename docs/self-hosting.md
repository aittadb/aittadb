# Self-Hosting Limitations

The default upstream identity adapter receives the result of ChatGPT sign-in only inside the trusted ChatGPT Sites runtime. A generic Cloudflare Worker or other host must not trust browser-sent `oai-authenticated-user-*` headers.

Self-hosted deployments must implement `UpstreamIdentityProvider` for a trusted server-side identity source and inject it while composing the application. They must not reuse the Sites header provider at an untrusted edge or add environment-selected mock users. Update `AGENTS.md`, OpenAPI documentation, tests, and this file in the same task.

AittaDB storage also depends on D1-like SQL durability and R2-like object storage. A self-hosted adapter must preserve the same ownership model: JSON records and file metadata keyed by immutable AittaDB user UUID and OAuth client ID, file bytes behind server-generated object keys, and no trust in caller-supplied physical storage paths.
