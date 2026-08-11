import assert from "node:assert/strict";
import test from "node:test";

import { nowSeconds } from "../../src/crypto";
import { MemoryAuthStore } from "../../src/store/memory";
import { createTestAittaDB, testEnv } from "../helpers";

class CountingStatisticsStore extends MemoryAuthStore {
  countUsersCalls = 0;

  override async countUsers(): Promise<number> {
    this.countUsersCalls += 1;
    return super.countUsers();
  }
}

class RejectingStatisticsStore extends MemoryAuthStore {
  countUsersCalls = 0;

  override async countUsers(): Promise<number> {
    this.countUsersCalls += 1;
    throw new Error("statistics query must not run");
  }
}

test("enabled statistics execute the bounded aggregate query", async () => {
  const env = await testEnv({ FEATURE_STATISTICS_ENABLED: "true" });
  const store = new CountingStatisticsStore();
  await store.findOrCreateUser(
    {
      email: "statistics-user@example.test",
      fullName: null,
      displayName: "statistics-user@example.test",
    },
    nowSeconds(),
  );
  const app = createTestAittaDB(env, store, null);

  const response = await app.fetch(
    new Request("https://aittadb.example.test/statistics", {
      headers: { accept: "application/vnd.aittadb+json; version=0.1" },
    }),
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.deepEqual(
    ((await response.json()) as { data: { identity_count: number } }).data,
    { identity_count: 1 },
  );
  assert.equal(store.countUsersCalls, 1);
});

test("disabled statistics omit discovery and never query identities", async () => {
  const env = await testEnv({ FEATURE_STATISTICS_ENABLED: "false" });
  const store = new RejectingStatisticsStore();
  const app = createTestAittaDB(env, store, null);

  const rootJsonResponse = await app.fetch(
    new Request("https://aittadb.example.test/", {
      headers: { accept: "application/vnd.aittadb+json; version=0.1" },
    }),
  );
  assert.ok(rootJsonResponse);
  assert.equal(rootJsonResponse.status, 200);
  const rootJson = (await rootJsonResponse.json()) as {
    data: {
      service: string;
      features: {
        records: boolean;
        files: boolean;
        statistics: boolean;
        oauthApps: boolean;
        events: boolean;
      };
    };
    links: Array<{ rel: string[]; href: string }>;
    actions: Array<{ name: string; href: string }>;
  };
  assert.equal(rootJson.data.service, "AittaDB");
  assert.deepEqual(rootJson.data.features, {
    records: true,
    files: true,
    statistics: false,
    oauthApps: false,
    events: false,
  });
  assert.equal(
    rootJson.links.some((item) => item.rel.includes("statistics")),
    false,
  );
  assert.equal(
    rootJson.actions.some((item) => item.name === "read-statistics"),
    false,
  );
  assert.ok(rootJson.links.some((item) => item.rel.includes("health")));
  assert.ok(rootJson.links.some((item) => item.rel.includes("privacy-policy")));
  assert.ok(
    rootJson.links.some((item) => item.rel.includes("storage-records")),
  );
  assert.ok(rootJson.links.some((item) => item.rel.includes("storage-files")));

  const rootHtmlResponse = await app.fetch(
    new Request("https://aittadb.example.test/", {
      headers: { accept: "text/html" },
    }),
  );
  assert.ok(rootHtmlResponse);
  const rootHtml = await rootHtmlResponse.text();
  assert.equal(rootHtmlResponse.status, 200);
  assert.match(rootHtml, /Statistics off/);
  assert.doesNotMatch(rootHtml, /href="\/statistics"/);
  assert.match(rootHtml, /href="\/health"/);
  assert.match(rootHtml, /href="\/privacy"/);
  assert.match(rootHtml, /href="\/storage\/records"/);
  assert.match(rootHtml, /href="\/storage\/files"/);

  const unavailableJsonResponse = await app.fetch(
    new Request("https://aittadb.example.test/statistics", {
      headers: { accept: "application/vnd.aittadb+json; version=0.1" },
    }),
  );
  assert.ok(unavailableJsonResponse);
  assert.equal(unavailableJsonResponse.status, 503);
  assert.match(
    unavailableJsonResponse.headers.get("content-type") ?? "",
    /^application\/vnd\.aittadb\+json; version=0\.1/,
  );
  const unavailableJson = (await unavailableJsonResponse.json()) as {
    error: string;
    error_description: string;
    data: { error: string; error_description: string };
    links: Array<{ rel: string[]; href: string }>;
    actions: unknown[];
  };
  assert.equal(unavailableJson.error, "feature_unavailable");
  assert.equal(unavailableJson.data.error, "feature_unavailable");
  assert.equal(
    unavailableJson.error_description,
    "Service statistics are disabled by deployment configuration",
  );
  assert.equal(
    unavailableJson.data.error_description,
    unavailableJson.error_description,
  );
  assert.ok(unavailableJson.links.some((item) => item.rel.includes("service")));
  assert.ok(unavailableJson.links.some((item) => item.rel.includes("health")));
  assert.equal(unavailableJson.actions.length, 0);

  const unavailableHtmlResponse = await app.fetch(
    new Request("https://aittadb.example.test/statistics", {
      headers: { accept: "text/html" },
    }),
  );
  assert.ok(unavailableHtmlResponse);
  const unavailableHtml = await unavailableHtmlResponse.text();
  assert.equal(unavailableHtmlResponse.status, 503);
  assert.match(
    unavailableHtmlResponse.headers.get("content-type") ?? "",
    /^text\/html/,
  );
  assert.match(unavailableHtml, /<h1>Service unavailable<\/h1>/);
  assert.match(unavailableHtml, /feature_unavailable/);
  assert.match(
    unavailableHtml,
    /Service statistics are disabled by deployment configuration/,
  );

  const healthResponse = await app.fetch(
    new Request("https://aittadb.example.test/health", {
      headers: { accept: "application/json" },
    }),
  );
  assert.ok(healthResponse);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(
    (
      (await healthResponse.json()) as {
        data: { ok: boolean; service: string; d1: boolean; r2: boolean };
      }
    ).data,
    { ok: true, service: "aittadb", d1: true, r2: true },
  );
  assert.equal(store.countUsersCalls, 0);
});
