import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  formatSecretFinding,
  scanTrackedFile,
  scanTrackedFiles,
} from "../../scripts/secret-safety";

test("secret safety rejects runtime credential paths but retains safe templates", () => {
  const findings = scanTrackedFiles([
    { path: ".env.local", contents: "" },
    { path: ".openai/hosting.json", contents: "{}" },
    { path: ".secrets/jwt-signing-key.json", contents: "{}" },
    { path: ".wrangler/state/v3/d1.json", contents: "{}" },
    { path: "credentials.json", contents: "{}" },
    { path: ".env.example", contents: "JWT_PRIVATE_JWK=\n" },
    { path: ".dev.vars.example", contents: "JWT_PRIVATE_JWK=\n" },
    {
      path: ".openai/hosting.example.json",
      contents: '{"project_id":"replace-with-your-sites-project-id"}',
    },
  ]);

  assert.deepEqual(
    findings.map(({ category, path }) => [category, path]),
    [
      ["forbidden-secret-path", ".env.local"],
      ["forbidden-secret-path", ".openai/hosting.json"],
      ["forbidden-secret-path", ".secrets/jwt-signing-key.json"],
      ["forbidden-secret-path", ".wrangler/state/v3/d1.json"],
      ["forbidden-secret-path", "credentials.json"],
    ],
  );
});

test("history may classify legacy hosting metadata without skipping content checks", () => {
  const providerToken = "ghp_" + "a".repeat(36);

  assert.deepEqual(
    scanTrackedFile(
      { path: ".openai/hosting.json", contents: '{"project_id":"public-id"}' },
      { allowLegacyHostingPath: true },
    ),
    [],
  );
  assert.deepEqual(
    scanTrackedFile(
      { path: ".openai/hosting.json", contents: providerToken },
      { allowLegacyHostingPath: true },
    ).map(({ category }) => category),
    ["provider-credential"],
  );
});

test("secret safety rejects private keys and private JWK components", () => {
  const privateComponent = "A".repeat(43);
  const findings = scanTrackedFiles([
    {
      path: "config/signing.txt",
      contents: [
        "-----BEGIN " + "PRIVATE KEY-----",
        "redacted-for-unit-test",
        "-----END " + "PRIVATE KEY-----",
      ].join("\n"),
    },
    {
      path: "config/encrypted-signing.txt",
      contents:
        "-----BEGIN " + "ENCRYPTED PRIVATE KEY-----\nredacted-for-unit-test",
    },
    {
      path: "config/signing.json",
      contents: JSON.stringify({
        kty: "EC",
        crv: "P-256",
        d: privateComponent,
      }),
    },
  ]);

  assert.deepEqual(
    findings.map(({ category, path }) => [category, path]),
    [
      ["private-key", "config/encrypted-signing.txt"],
      ["private-jwk", "config/signing.json"],
      ["private-key", "config/signing.txt"],
    ],
  );
});

test("secret safety rejects obvious provider and bearer-equivalent values", () => {
  const providerToken = "ghp_" + "a".repeat(36);
  const npmToken = "npm_" + "n".repeat(36);
  const bearerToken = "live-value-" + "b".repeat(32);
  const findings = scanTrackedFiles([
    { path: "config/provider.txt", contents: providerToken },
    { path: "config/npm-provider.txt", contents: npmToken },
    {
      path: "config/runtime.env.example.txt",
      contents: `ACCESS_TOKEN=${bearerToken}`,
    },
    {
      path: "config/header.txt",
      contents: `Authorization: Bearer ${bearerToken}`,
    },
  ]);

  assert.deepEqual(
    findings.map(({ category, path }) => [category, path]),
    [
      ["bearer-credential", "config/header.txt"],
      ["provider-credential", "config/npm-provider.txt"],
      ["provider-credential", "config/provider.txt"],
      ["bearer-credential", "config/runtime.env.example.txt"],
    ],
  );
});

test("secret safety rejects provider-named literal assignments", () => {
  const value = "live-value-" + "d".repeat(32);
  const findings = scanTrackedFiles(
    ["CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY"].map(
      (name) => ({
        path: `config/${name.toLowerCase()}.txt`,
        contents: `${name}="${value}"`,
      }),
    ),
  );

  assert.equal(findings.length, 4);
  assert.ok(findings.every(({ category }) => category === "bearer-credential"));
});

test("secret safety allows inert documentation placeholders and synthetic tests", () => {
  assert.deepEqual(
    scanTrackedFiles([
      {
        path: "docs/example.md",
        contents:
          "Authorization: Bearer <access-token>\nCLIENT_SECRET=replace-me",
      },
      {
        path: "tests/helpers.ts",
        contents:
          'const clientSecret = "synthetic-test-client-secret";\n' +
          "Authorization: Bearer deliberately-invalid-test-credential",
      },
      {
        path: "public/vendor/example.js",
        contents: 'const password = "library-example-placeholder";',
      },
      {
        path: "tests/fixtures/private.key",
        contents:
          "AITTADB_SYNTHETIC_TEST_FIXTURE\n-----BEGIN " +
          "PRIVATE KEY-----\nfixture-only",
      },
    ]),
    [],
  );
});

test("secret safety output never includes matched credential values", () => {
  const value = "live-value-" + "c".repeat(32);
  const [finding] = scanTrackedFile({
    path: "config/runtime.txt",
    contents: `ACCESS_TOKEN=${value}`,
  });

  assert.ok(finding);
  const output = formatSecretFinding({ ...finding, commit: "abc123" });
  assert.equal(output, "bearer-credential\tconfig/runtime.txt\tabc123");
  assert.doesNotMatch(output, new RegExp(value));
});

test("validation and exact-commit CI run the tracked-tree guard", async () => {
  const [packageSource, workflow] = await Promise.all([
    readFile(new URL("../../package.json", import.meta.url), "utf8"),
    readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  ]);
  const packageJson = JSON.parse(packageSource) as {
    scripts?: Record<string, string>;
  };

  assert.equal(
    packageJson.scripts?.["secrets:check"],
    "node --import tsx scripts/check-secret-safety.ts",
  );
  assert.match(packageJson.scripts?.validate ?? "", /npm run secrets:check/);
  assert.match(workflow, /- run: npm run secrets:check/);
});
