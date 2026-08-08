# Contributing

Read `AGENTS.md` before changing code. Every implementation change must include the public contract, implementation, automated tests, documentation, validation evidence, and any necessary `AGENTS.md`, OpenAPI, schema, migration, or architecture updates in the same task.

Use [PLAN.md](PLAN.md) for accepted, dependency-ordered unfinished implementation work, [CHANGELOG.md](CHANGELOG.md) for completed task history, [ROADMAP.md](ROADMAP.md) for stable future product direction, and [BACKLOG.md](BACKLOG.md) for uncommitted ideas with no delivery commitment. Before implementation, create a complete unchecked PLAN task using the next identifier across PLAN and CHANGELOG. After its complete definition of done passes, move its stable identifier and unchanged description from PLAN into the changelog atomically. Roadmap and backlog checkboxes describe unavailable work and do not authorize implementation.

When declaring work ready, include a `0/100` evidence-based readiness confidence, the decisive validation evidence, and material residual uncertainty. The score does not waive security controls or the definition of done. Record remaining findings in PLAN, ROADMAP, or BACKLOG before handoff, and prefer a small verified risk reduction to speculative complexity.

Use feature branches. Do not push directly to `main`, merge without review, deploy, publish, save a production checkpoint, or change Sites access settings without explicit approval.

Run `npm run validate` before requesting review. It includes the tracked-tree `npm run secrets:check` guard and `npm run agents:check`; keep the authoritative root `AGENTS.md` below 32,000 bytes so Codex loads the complete instruction set by default. For secret-safety acceptance in a complete clone, also run `npm run secrets:audit-history`; report findings only by category, path, and commit. Prefer concise rules and move explanatory background to linked files in `docs/`.

Dependencies are lockfile-pinned where runtime compatibility or vendored browser assets matter. Run `npm ci` for a clean install and do not suppress the explicit `npm run audit:high` result. Dependabot tracks routine npm updates; React, React Server Components, Vinext, Vite, Cloudflare, and Wrangler updates must be tested as a compatible group.

The project uses handwritten, prepared D1 SQL rather than Drizzle ORM. Update `db/migrations/`, `db/schema.ts`, the `AuthStore` contract, both repository implementations, and focused migration/parity tests together when a persisted primitive changes. Prove consistency with `npm run db:check`. There is intentionally no `db:generate` command.

Subject authorization after account-deletion start belongs only in `src/subject-access.ts`. Token issuance, access-token consumers, refresh rotation, current sessions, and storage must reuse that gate and translate its denial to generic protocol errors. Do not infer behavior from job states in route handlers or let `ADMIN_SUBJECTS` reach the deletion repository through another start path.

Swagger UI is pinned in `package.json` and self-hosted from `public/vendor/swagger-ui/`. After changing `swagger-ui-dist`, run `npm run swagger:sync`; CI verifies the checked-in assets with `npm run swagger:check`.

When adding a state-changing browser form adapter, add its route to the centralized pre-body origin classification and the table-driven route proof in the same task. Do not defer origin detection until after reading a hidden form field; machine OAuth and raw bearer storage protocols must remain independently usable.

Clean-checkout validation uses `.openai/hosting.example.json` when the ignored checkout-local `.openai/hosting.json` does not exist. Create the local file with your own Sites project ID before running or deploying an actual Sites instance; the template is only a non-secret build fallback.
