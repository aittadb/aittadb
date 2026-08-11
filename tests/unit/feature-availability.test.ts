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

test("Events collection paging and read-rate configuration is finite and strict", async () => {
  const defaults = await testEnv();
  const defaultConfig = loadConfig(defaults, defaults.ISSUER_URL!);
  assert.equal(defaultConfig.eventDefaultPageSize, 50);
  assert.equal(defaultConfig.eventMaxPageSize, 100);
  assert.equal(defaultConfig.eventReadRateLimit, 120);
  assert.equal(defaultConfig.eventSubscribeRateLimit, 30);
  assert.equal(defaultConfig.eventMaxWaitSeconds, 25);
  assert.equal(defaultConfig.eventMaxWaitReads, 26);

  const custom = await testEnv({
    EVENTS_DEFAULT_PAGE_SIZE: "7",
    EVENTS_MAX_PAGE_SIZE: "13",
    EVENTS_READ_RATE_LIMIT: "29",
    EVENTS_SUBSCRIBE_RATE_LIMIT: "11",
    EVENTS_MAX_WAIT_SECONDS: "7",
    EVENTS_MAX_WAIT_READS: "8",
  });
  const customConfig = loadConfig(custom, custom.ISSUER_URL!);
  assert.equal(customConfig.eventDefaultPageSize, 7);
  assert.equal(customConfig.eventMaxPageSize, 13);
  assert.equal(customConfig.eventReadRateLimit, 29);
  assert.equal(customConfig.eventSubscribeRateLimit, 11);
  assert.equal(customConfig.eventMaxWaitSeconds, 7);
  assert.equal(customConfig.eventMaxWaitReads, 8);

  for (const [name, value, pattern] of [
    ["EVENTS_DEFAULT_PAGE_SIZE", "0", /Expected positive integer/],
    ["EVENTS_MAX_PAGE_SIZE", "101", /must not exceed 100/],
    ["EVENTS_READ_RATE_LIMIT", "1.5", /Expected positive integer/],
    ["EVENTS_SUBSCRIBE_RATE_LIMIT", "0", /Expected positive integer/],
    ["EVENTS_MAX_WAIT_SECONDS", "31", /must not exceed 30/],
    ["EVENTS_MAX_WAIT_READS", "32", /must not exceed 31/],
    ["EVENTS_MAX_WAIT_READS", "1", /must be at least 2/],
  ] as const) {
    const env = await testEnv({ [name]: value });
    assert.throws(() => loadConfig(env, env.ISSUER_URL!), pattern);
  }

  const inverted = await testEnv({
    EVENTS_DEFAULT_PAGE_SIZE: "11",
    EVENTS_MAX_PAGE_SIZE: "10",
  });
  assert.throws(
    () => loadConfig(inverted, inverted.ISSUER_URL!),
    /EVENTS_DEFAULT_PAGE_SIZE must not exceed EVENTS_MAX_PAGE_SIZE/,
  );
});
