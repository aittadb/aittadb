# ChatGPT Sites maintenance and upgrades

AittaDB is operated through its ChatGPT Sites project and its private Sites source mirror. Do not use a direct Cloudflare administration workflow. This runbook is for bounded operational primitives, not for application data administration.

## Acceptance upgrade

1. Start from a committed public-source revision with `npm run validate` passing. The repository remains secret-free; Sites project metadata, configuration, and credentials stay outside it.
2. Resolve the stored Sites project ID and verify its title and current live URL match the intended target custom domain. Do this before any source-mirror push, configuration mutation, saved version, or deployment. A source-mirror hostname, similar title, or version number is never target identity.
3. Package the checked-in migrations with the build and push that exact `develop` commit to the verified Sites mirror using a short-lived credential supplied only to the Git process environment.
4. Create or update the acceptance version from that source commit. Verify the version records the intended commit and that D1 migrations apply before exercising a changed route.
5. Make one reviewable configuration change at a time through ChatGPT Sites. Preserve bindings, access mode, unrelated variables, and source version. Record only the setting names and redacted before/after state.
6. Exercise the named behavior with the least-privilege Sites session or client. Retain only count-only or credential-free evidence; never copy secrets, client IDs, bearer values, stored values, namespace names, D1 output, or hosted settings into Git, logs, or public reports.

## Acceptance-only namespace maintenance

`ACCEPTANCE_NAMESPACE_MAINTENANCE_ENABLED` is default-off. It can be enabled only for the reviewed `https://test.aittadb.com` issuer with Records and OAuth Apps already enabled. It does not create a general D1 console or a data-recovery API.

While enabled, an allowlisted Sites administrator can use `/admin/maintenance/bounded-service-namespaces`. The route accepts one active service-client namespace and exactly one disposable proof collection prefix in the form `proof-` plus 24 lower-case hexadecimal characters plus `-`, preflights at most 100 matching bounded-record rows plus durable transaction receipts, and returns counts only. Candidate discovery uses the namespace/collection index, has an overflow sentinel, and bounds receipt-membership inspection to 2,501 rows; it never performs a namespace-wide count. The D1 batch qualifies the non-human principal, inserts the redacted count-only audit event, and removes selected rows atomically. It cannot select a human namespace, files, raw D1/R2 resources, configuration, or secrets. Same-origin, CSRF, rate limiting, a one-time submission, audit attribution, and server-side service-client validation remain mandatory.

For a repair, deploy the accepted source first, enable only this setting on acceptance, sign in as the configured administrator, run one bounded request, verify zero remaining matching counts, and disable the setting immediately after the evidence is collected. A request over the bound fails without deleting anything. Migration backfill can associate an older receipt only when every result entry contains a normal record key; ambiguous legacy delete/check receipts remain untouched and require a new bounded maintenance task.

## Rollback, cleanup, and promotion

If acceptance fails, disable the temporary feature setting and redeploy the previously accepted source revision. D1 migrations are forward-only: do not attempt to rewrite applied migration history or erase data as a rollback substitute. Record the failed commit, setting name, validation outcome, and residual risk without sensitive values.

After acceptance passes, clean synthetic fixtures and revoke temporary credentials through their dedicated approved tasks. Production promotion requires explicit approval and uses the identical accepted source commit/build, with only the target Sites project metadata differing. Apply the same migration/status verification at production and never widen access, alter DNS, or change unrelated production settings as part of an upgrade.
