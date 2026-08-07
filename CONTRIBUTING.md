# Contributing

Read `AGENTS.md` before changing code. Every implementation change must include the public contract, implementation, automated tests, documentation, validation evidence, and any necessary `AGENTS.md`, OpenAPI, schema, migration, or architecture updates in the same task.

Use [PLAN.md](PLAN.md) for accepted, dependency-ordered implementation work, [ROADMAP.md](ROADMAP.md) for stable future product direction, and [BACKLOG.md](BACKLOG.md) for uncommitted ideas with no delivery commitment. Roadmap and backlog checkboxes describe unavailable work. Before implementing either, create a complete unchecked PLAN task; do not treat a checkbox in those files as authorization to begin.

When declaring work ready, include a `0/100` evidence-based readiness confidence, the decisive validation evidence, and material residual uncertainty. The score does not waive security controls or the definition of done. Record remaining findings in PLAN, ROADMAP, or BACKLOG before handoff, and prefer a small verified risk reduction to speculative complexity.

Use feature branches. Do not push directly to `main`, merge without review, deploy, publish, save a production checkpoint, or change Sites access settings without explicit approval.

Run `npm run validate` before requesting review. It includes `npm run agents:check`; keep the authoritative root `AGENTS.md` below 32,000 bytes so Codex loads the complete instruction set by default. Prefer concise rules and move explanatory background to linked files in `docs/`.

Dependencies are lockfile-pinned where runtime compatibility or vendored browser assets matter. Run `npm ci` for a clean install and do not suppress the explicit `npm run audit:high` result. Dependabot tracks routine npm updates; React, React Server Components, Vinext, Vite, Cloudflare, and Wrangler updates must be tested as a compatible group.

The project uses handwritten, prepared D1 SQL rather than Drizzle ORM. Update `db/migrations/`, `db/schema.ts`, and `src/store/migrations.ts` together and prove consistency with `npm run db:check`. There is intentionally no `db:generate` command.

Swagger UI is pinned in `package.json` and self-hosted from `public/vendor/swagger-ui/`. After changing `swagger-ui-dist`, run `npm run swagger:sync`; CI verifies the checked-in assets with `npm run swagger:check`.

Clean-checkout validation uses `.openai/hosting.example.json` when the ignored checkout-local `.openai/hosting.json` does not exist. Create the local file with your own Sites project ID before running or deploying an actual Sites instance; the template is only a non-secret build fallback.
