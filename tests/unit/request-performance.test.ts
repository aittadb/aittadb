import test from "node:test";
import assert from "node:assert/strict";
import { createAittaDB } from "../../src/handler";
import { testEnv } from "../helpers";

function normalizedQueries(values: readonly string[]): string[] {
  return values.map((query) => query.replace(/\s+/g, " ").trim());
}

test("public requests avoid D1 and background cleanup failures cannot replace responses", async (t) => {
  const queries: string[] = [];
  const cleanupFailure = "private-cleanup-failure";
  const errorLogs: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => {
    errorLogs.push(values);
  };
  t.after(() => {
    console.error = originalConsoleError;
  });
  const db: D1Database = {
    prepare(query: string): D1PreparedStatement {
      queries.push(query);
      let values: unknown[] = [];
      const statement: D1PreparedStatement = {
        bind(...nextValues: unknown[]): D1PreparedStatement {
          values = nextValues;
          return statement;
        },
        async all<T>(): Promise<D1Result<T>> {
          if (/^\s*INSERT INTO users/.test(query)) {
            return {
              success: true,
              results: [
                {
                  id: values[0],
                  email: values[1],
                  display_name: values[2],
                  created_at: values[3],
                  updated_at: values[3],
                } as T,
              ],
            };
          }
          return { success: true, results: [] };
        },
        async first<T>(): Promise<T | null> {
          return null;
        },
        async run<T>(): Promise<D1Result<T>> {
          if (query.startsWith("DELETE FROM admin_operation_submissions")) {
            throw new Error(cleanupFailure);
          }
          return { success: true, results: [] };
        },
      };
      return statement;
    },
  };
  const maintenance: Array<Promise<unknown>> = [];
  const env = await testEnv({
    DB: db,
    PRIVACY_CONTROLLER_NAME: "AittaDB Test Operator",
    PRIVACY_CONTACT_EMAIL: "privacy@example.test",
  });
  const app = await createAittaDB(env, {
    waitUntil(promise) {
      maintenance.push(promise);
    },
  });

  assert.deepEqual(queries, []);
  const root = await app.fetch(
    new Request("https://aittadb.example.test/", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(root?.status, 200);
  assert.deepEqual(queries, []);
  const explicitPrivacy = await app.fetch(
    new Request("https://aittadb.example.test/privacy", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(explicitPrivacy?.status, 200);
  assert.deepEqual(queries, []);
  const authScript = await app.fetch(
    new Request("https://aittadb.example.test/auth-ui.js"),
  );
  assert.equal(authScript?.status, 200);
  assert.match(authScript?.headers.get("content-type") ?? "", /javascript/);
  assert.deepEqual(queries, []);
  assert.equal(
    await app.fetch(
      new Request("https://aittadb.example.test/aittadb-mark.svg"),
    ),
    null,
  );
  assert.deepEqual(queries, []);

  const fallbackSubject = crypto.randomUUID();
  const fallbackEnv = await testEnv({
    DB: db,
    ADMIN_SUBJECTS: fallbackSubject,
  });
  const fallbackApp = await createAittaDB(fallbackEnv);
  const fallbackPrivacy = await fallbackApp.fetch(
    new Request("https://aittadb.example.test/privacy", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(fallbackPrivacy?.status, 503);
  assert.deepEqual(normalizedQueries(queries), [
    "SELECT * FROM users WHERE id = ? AND principal_type = 'user'",
  ]);
  queries.length = 0;

  const session = await app.fetch(
    new Request("https://aittadb.example.test/session", {
      headers: {
        accept: "application/json",
        "oai-authenticated-user-email": "user@example.test",
        "oai-authenticated-user-full-name": "Test%20User",
        "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
      },
    }),
  );
  assert.equal(session?.status, 200);
  assert.equal((await session!.text()).includes(cleanupFailure), false);
  await Promise.all(maintenance);
  assert.deepEqual(errorLogs, [["maintenance.cleanup.failed"]]);
  assert.equal(JSON.stringify(errorLogs).includes(cleanupFailure), false);
  assert.match(
    normalizedQueries(queries).join("\n"),
    /INSERT INTO users .* ON CONFLICT\(email\) DO UPDATE .* RETURNING/,
  );
  assert.doesNotMatch(queries.join("\n"), /SELECT \* FROM users WHERE email/);
  assert.match(queries.join("\n"), /DELETE FROM rate_limit_counters/);
  assert.match(queries.join("\n"), /DELETE FROM admin_operation_submissions/);
  assert.equal(
    queries.some((query) => /^\s*(?:CREATE|ALTER|DROP)\b/i.test(query)),
    false,
  );
});
