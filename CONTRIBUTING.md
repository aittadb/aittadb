# Contributing

Read `AGENTS.md` before changing code. Every implementation change must include the public contract, implementation, automated tests, documentation, validation evidence, and any necessary `AGENTS.md`, OpenAPI, schema, migration, or architecture updates in the same task.

Use feature branches. Do not push directly to `main`, merge without review, deploy, publish, save a production checkpoint, or change Sites access settings without explicit approval.

Run `npm run validate` before requesting review.

Clean-checkout validation uses `.openai/hosting.example.json` when the ignored checkout-local `.openai/hosting.json` does not exist. Create the local file with your own Sites project ID before running or deploying an actual Sites instance; the template is only a non-secret build fallback.
