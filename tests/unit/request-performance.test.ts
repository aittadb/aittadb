import test from "node:test";
import assert from "node:assert/strict";
import { createAittaDB } from "../../src/handler";
import { testEnv } from "../helpers";

function normalizedQueries(values: readonly string[]): string[] {
  return values.map((query) => query.replace(/\s+/g, " ").trim());
}

test("public requests perform no D1 work and runtime requests never apply schema DDL", async () => {
  const queries: string[] = [];
  const db: D1Database = {
    prepare(query: string): D1PreparedStatement {
      queries.push(query);
      const statement: D1PreparedStatement = {
        bind(): D1PreparedStatement {
          return statement;
        },
        async all<T>(): Promise<D1Result<T>> {
          return { success: true, results: [] };
        },
        async first<T>(): Promise<T | null> {
          return null;
        },
        async run<T>(): Promise<D1Result<T>> {
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
    "SELECT * FROM users WHERE id = ?",
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
  await Promise.all(maintenance);
  assert.match(queries.join("\n"), /SELECT \* FROM users/);
  assert.equal(
    queries.some((query) => /^\s*(?:CREATE|ALTER|DROP)\b/i.test(query)),
    false,
  );
});
