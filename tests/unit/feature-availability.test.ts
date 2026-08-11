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
    events: false,
  });
});

test("feature availability accepts strict independent boolean values", async () => {
  const env = await testEnv({
    FEATURE_RECORDS_ENABLED: "false",
    FEATURE_FILES_ENABLED: "0",
    FEATURE_STATISTICS_ENABLED: "1",
    FEATURE_OAUTH_APPS_ENABLED: "true",
    FEATURE_EVENTS_ENABLED: "1",
  });

  assert.deepEqual(loadConfig(env, env.ISSUER_URL!).features, {
    records: false,
    files: false,
    statistics: true,
    oauthApps: true,
    events: true,
  });
});

test("Events availability accepts only the four exact boolean values", async () => {
  for (const [value, expected] of [
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ] as const) {
    const env = await testEnv({ FEATURE_EVENTS_ENABLED: value });
    assert.equal(
      loadConfig(env, env.ISSUER_URL!).features.events,
      expected,
      value,
    );
  }
});

test("malformed feature availability fails closed", async () => {
  const names = [
    "FEATURE_RECORDS_ENABLED",
    "FEATURE_FILES_ENABLED",
    "FEATURE_STATISTICS_ENABLED",
    "FEATURE_OAUTH_APPS_ENABLED",
    "FEATURE_EVENTS_ENABLED",
  ] as const;

  for (const name of names) {
    const env = await testEnv({ [name]: "enabled" });
    assert.throws(
      () => loadConfig(env, env.ISSUER_URL!),
      /Expected boolean, received enabled/,
    );
  }
});

test("empty and noncanonical Events availability fail closed", async () => {
  for (const value of ["", "TRUE", " true ", "yes", "2"]) {
    const env = await testEnv({ FEATURE_EVENTS_ENABLED: value });
    assert.throws(
      () => loadConfig(env, env.ISSUER_URL!),
      /Expected boolean/,
      value,
    );
  }
});
