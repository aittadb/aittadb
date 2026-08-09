import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { testEnv } from "../helpers";

test("feature availability has secure independent defaults", async () => {
  const env = await testEnv();

  assert.deepEqual(loadConfig(env, env.ISSUER_URL!).features, {
    records: true,
    files: true,
    statistics: true,
    oauthApps: false,
  });
});

test("feature availability accepts strict independent boolean values", async () => {
  const env = await testEnv({
    FEATURE_RECORDS_ENABLED: "false",
    FEATURE_FILES_ENABLED: "0",
    FEATURE_STATISTICS_ENABLED: "1",
    FEATURE_OAUTH_APPS_ENABLED: "true",
  });

  assert.deepEqual(loadConfig(env, env.ISSUER_URL!).features, {
    records: false,
    files: false,
    statistics: true,
    oauthApps: true,
  });
});

test("malformed feature availability fails closed", async () => {
  const names = [
    "FEATURE_RECORDS_ENABLED",
    "FEATURE_FILES_ENABLED",
    "FEATURE_STATISTICS_ENABLED",
    "FEATURE_OAUTH_APPS_ENABLED",
  ] as const;

  for (const name of names) {
    const env = await testEnv({ [name]: "enabled" });
    assert.throws(
      () => loadConfig(env, env.ISSUER_URL!),
      /Expected boolean, received enabled/,
    );
  }
});
