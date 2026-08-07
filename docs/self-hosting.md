# Self-Hosting Limitations

The default upstream identity adapter is designed for ChatGPT Sites. A generic Cloudflare Worker or other host must not trust browser-sent `oai-authenticated-user-*` headers.

Self-hosted deployments must replace `src/identity.ts` with an adapter backed by a trusted identity provider, then update `AGENTS.md`, OpenAPI documentation, tests, and this file in the same task.
