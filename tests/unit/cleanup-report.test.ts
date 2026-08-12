import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { scheduleCleanup } from "../../src/handler";
import {
  CLEANUP_CATEGORIES,
  CLEANUP_CATEGORY_LIMITS,
  createCleanupReport,
  type CleanupCategory,
  type CleanupReport,
} from "../../src/store/cleanup";
import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import type { AuthorizationCode } from "../../src/types";
import { testEnv } from "../helpers";

test("cleanup telemetry configuration is strict and defaults off", async () => {
  const env = await testEnv();
  assert.equal(
    loadConfig(env, env.ISSUER_URL!).maintenanceCleanupTelemetryEnabled,
    false,
  );
  for (const value of ["true", "1"] as const) {
    assert.equal(
      loadConfig(
        { ...env, MAINTENANCE_CLEANUP_TELEMETRY_ENABLED: value },
        env.ISSUER_URL!,
      ).maintenanceCleanupTelemetryEnabled,
      true,
    );
  }
  for (const value of ["false", "0"] as const) {
    assert.equal(
      loadConfig(
        { ...env, MAINTENANCE_CLEANUP_TELEMETRY_ENABLED: value },
        env.ISSUER_URL!,
      ).maintenanceCleanupTelemetryEnabled,
      false,
    );
  }
  assert.throws(
    () =>
      loadConfig(
        { ...env, MAINTENANCE_CLEANUP_TELEMETRY_ENABLED: "enabled" },
        env.ISSUER_URL!,
      ),
    /Expected boolean, received enabled/,
  );
});

test("D1 cleanup reports only valid bounded mutation metadata", async () => {
  const counts = [2, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
  const results: D1Result[] = [
    { success: true },
    ...counts.map((changes) => ({ success: true, meta: { changes } })),
  ];
  const report = await new D1AuthStore(cleanupDatabase(results)).cleanup(100);

  assert.deepEqual(Object.keys(report), CLEANUP_CATEGORIES);
  for (const [index, category] of CLEANUP_CATEGORIES.entries()) {
    assert.deepEqual(report[category], {
      status: "verified",
      deletedCount: counts[index],
      limit: CLEANUP_CATEGORY_LIMITS[category],
    });
  }
  assert.equal(results.length, 0);
});

test("D1 cleanup marks missing and malformed mutation counts unverifiable", async () => {
  const malformed: D1Result[] = [
    { success: true },
    { success: true },
    { success: true, meta: {} },
    { success: true, meta: { changes: "1" } },
    { success: true, meta: { changes: -1 } },
    { success: true, meta: { changes: 1.5 } },
    { success: true, meta: { changes: 501 } },
    { success: true, meta: [] },
    { success: true, meta: { changes: Number.NaN } },
    { success: true, meta: { changes: Number.POSITIVE_INFINITY } },
    { success: true, meta: { changes: Number.MAX_SAFE_INTEGER + 1 } },
    { success: true, meta: { changes: -0.5 } },
    { success: true, meta: { changes: 502 } },
  ];
  const report = await new D1AuthStore(cleanupDatabase(malformed)).cleanup(100);

  for (const category of CLEANUP_CATEGORIES) {
    assert.deepEqual(report[category], {
      status: "unverifiable",
      deletedCount: null,
      limit: CLEANUP_CATEGORY_LIMITS[category],
    });
  }
  assert.equal(malformed.length, 0);
});

test("D1 cleanup rejects an unsuccessful mutation result", async () => {
  const results: D1Result[] = [{ success: true }, { success: false }];
  await assert.rejects(
    new D1AuthStore(cleanupDatabase(results)).cleanup(100),
    /cleanup_mutation_failed/,
  );
});

test("memory cleanup preserves fixed report and batch-limit parity", async () => {
  const store = new MemoryAuthStore();
  for (let index = 0; index < 501; index += 1) {
    const code = authorizationCode(index);
    store.authCodes.set(code.codeHash, code);
  }

  const report = await store.cleanup(100);

  assert.deepEqual(Object.keys(report), CLEANUP_CATEGORIES);
  assert.equal(store.authCodes.size, 1);
  assert.deepEqual(report["authorization-codes"], {
    status: "verified",
    deletedCount: 500,
    limit: 500,
  });
  for (const category of CLEANUP_CATEGORIES) {
    assert.equal(report[category].status, "verified");
    assert.equal(report[category].limit, CLEANUP_CATEGORY_LIMITS[category]);
  }
});

test("cleanup scheduling catches failures and emits bounded private telemetry", async (t) => {
  const errorLogs: unknown[][] = [];
  const infoLogs: unknown[][] = [];
  const originalError = console.error;
  const originalInfo = console.info;
  console.error = (...values: unknown[]) => errorLogs.push(values);
  console.info = (...values: unknown[]) => infoLogs.push(values);
  t.after(() => {
    console.error = originalError;
    console.info = originalInfo;
  });

  const scheduled: Array<Promise<unknown>> = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>): void {
      scheduled.push(promise);
    },
  };
  const privateFailure = "email@example.test SELECT secret FROM credentials";
  const failing = new FixedCleanupStore(() => {
    throw new Error(privateFailure);
  });
  assert.doesNotThrow(() =>
    scheduleCleanup(failing, undefined, ctx, 10_000_000_000, true),
  );
  await Promise.all(scheduled.splice(0));
  assert.deepEqual(errorLogs, [["maintenance.cleanup.failed"]]);
  assert.equal(JSON.stringify(errorLogs).includes(privateFailure), false);
  assertNoLogs(infoLogs);

  const counts = Object.fromEntries(
    CLEANUP_CATEGORIES.map((category) => [category, 1]),
  ) as Record<CleanupCategory, number | null>;
  counts["authorization-codes"] = null;
  const report = createCleanupReport(counts);
  const taintedReport = Object.assign(report, {
    secret: "private-key-material",
    identity: "user@example.test",
    sql: "SELECT * FROM users",
    eventId: "private-event-id",
    eventType: "private.event",
    payload: "private-event-payload",
    owner: "private-owner",
    client: "private-client",
    cursor: "private-cursor",
  });
  const successful = new FixedCleanupStore(() =>
    Promise.resolve(taintedReport),
  );

  scheduleCleanup(successful, undefined, ctx, 10_000_000_061, false);
  await Promise.all(scheduled.splice(0));
  assertNoLogs(infoLogs);

  scheduleCleanup(successful, undefined, ctx, 10_000_000_122, true);
  await Promise.all(scheduled.splice(0));
  assert.equal(infoLogs.length, 1);
  const emitted = infoLogs[0];
  assert.equal(emitted.length, 1);
  const rawPayload = emitted[0];
  assert.equal(typeof rawPayload, "string");
  if (typeof rawPayload !== "string") throw new Error("invalid_test_log");
  const payload = JSON.parse(rawPayload) as {
    event: string;
    categories: Array<{
      category: string;
      count: number | null;
      limit: number;
    }>;
  };
  assert.equal(payload.event, "maintenance.cleanup.completed");
  assert.deepEqual(
    payload.categories,
    CLEANUP_CATEGORIES.map((category) => ({
      category,
      count: category === "authorization-codes" ? null : 1,
      limit: CLEANUP_CATEGORY_LIMITS[category],
    })),
  );
  assert.equal(rawPayload.includes("private-key-material"), false);
  assert.equal(rawPayload.includes("user@example.test"), false);
  assert.equal(rawPayload.includes("SELECT"), false);
  assert.equal(rawPayload.includes("private-event"), false);
  assert.equal(rawPayload.includes("private.event"), false);
  assert.equal(rawPayload.includes("private-event-payload"), false);
  assert.equal(rawPayload.includes("private-owner"), false);
  assert.equal(rawPayload.includes("private-client"), false);
  assert.equal(rawPayload.includes("private-cursor"), false);
});

class FixedCleanupStore extends MemoryAuthStore {
  constructor(
    private readonly result: () => Promise<CleanupReport> | CleanupReport,
  ) {
    super();
  }

  override cleanup(): Promise<CleanupReport> {
    return Promise.resolve(this.result());
  }
}

function cleanupDatabase(results: D1Result[]): D1Database {
  return {
    prepare(): D1PreparedStatement {
      const statement: D1PreparedStatement = {
        bind(): D1PreparedStatement {
          return statement;
        },
        async first<T>(): Promise<T | null> {
          return null;
        },
        async all<T>(): Promise<D1Result<T>> {
          return { success: true, results: [] };
        },
        async run<T>(): Promise<D1Result<T>> {
          const result = results.shift();
          if (!result) throw new Error("unexpected_cleanup_statement");
          return result as D1Result<T>;
        },
      };
      return statement;
    },
  };
}

function authorizationCode(index: number): AuthorizationCode {
  return {
    codeHash: `code-${String(index).padStart(3, "0")}`,
    authRequestId: `request-${index}`,
    clientId: "client",
    redirectUri: "https://client.example/callback",
    userId: "user",
    scope: "openid",
    nonce: null,
    expiresAt: 1,
    consumedAt: null,
  };
}

function assertNoLogs(logs: unknown[][]): void {
  assert.deepEqual(logs, []);
}
