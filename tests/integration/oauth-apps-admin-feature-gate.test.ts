import assert from "node:assert/strict";
import test from "node:test";

import { nowSeconds } from "../../src/crypto";
import { createAittaDBWithStore } from "../../src/handler";
import { openApiSpec } from "../../src/openapi";
import { MemoryAuthStore } from "../../src/store/memory";
import { BROWSER_SESSION_CLIENT_ID } from "../../src/system-client";
import type { AuthStore, UpstreamIdentity } from "../../src/types";
import {
  createTestAittaDB,
  form,
  testEnv,
  testIdentityProvider,
} from "../helpers";

const ISSUER = "https://aittadb.example.test";
const HYPERMEDIA = "application/vnd.aittadb+json; version=0.1";
const ADMIN_IDENTITY: UpstreamIdentity = {
  email: "admin@example.test",
  fullName: "AittaDB Admin",
  displayName: "AittaDB Admin",
};

test("disabled OAuth Apps rejects client administration before repository work", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "false" });
  const observed = observeRepositoryCalls(new MemoryAuthStore());
  const scheduled: Promise<unknown>[] = [];
  const app = createAittaDBWithStore(
    env,
    observed.store,
    undefined,
    { waitUntil: (promise) => scheduled.push(promise) },
    testIdentityProvider(ADMIN_IDENTITY),
  );

  for (const request of [
    new Request(`${ISSUER}/admin/clients`, {
      headers: { accept: HYPERMEDIA },
    }),
    new Request(`${ISSUER}/admin/clients`, {
      method: "POST",
      headers: {
        accept: HYPERMEDIA,
        "content-type": "application/x-www-form-urlencoded",
        origin: ISSUER,
      },
      body: form({
        csrf_token: "invalid",
        submission_token: "invalid",
        action: "create",
        name: "Must not be parsed",
      }),
    }),
  ]) {
    const response = await app.fetch(request);
    assert.equal(response?.status, 503);
    assert.equal(response?.headers.get("cache-control"), "no-store");
    const document = (await response?.json()) as {
      error: string;
      data: { error: string; error_description: string };
      actions: Array<{ name: string; href: string }>;
    };
    assert.equal(document.error, "feature_unavailable");
    assert.equal(document.data.error, "feature_unavailable");
    assert.match(document.data.error_description, /OAuth Apps is disabled/);
    assert.ok(
      document.actions.some((action) => action.name === "open-service"),
    );
  }

  const htmlResponse = await app.fetch(
    new Request(`${ISSUER}/admin/clients`, {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(htmlResponse?.status, 503);
  assert.match(htmlResponse?.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await htmlResponse!.text(), /OAuth Apps is disabled/);

  const incompatible = await app.fetch(
    new Request(`${ISSUER}/admin/clients`, {
      headers: { accept: "application/vnd.aittadb+json; version=9" },
    }),
  );
  assert.equal(incompatible?.status, 406);

  assert.deepEqual(observed.calls, []);
  assert.deepEqual(scheduled, []);
});

test("disabled OAuth Apps hides administration but preserves the private current session", async () => {
  const store = new MemoryAuthStore();
  const user = await store.findOrCreateUser(ADMIN_IDENTITY, nowSeconds());
  const env = await testEnv({
    FEATURE_OAUTH_APPS_ENABLED: "false",
    ADMIN_SUBJECTS: user.id,
  });
  const app = createTestAittaDB(env, store, ADMIN_IDENTITY);

  for (const path of ["/", "/session"] as const) {
    const response = await app.fetch(
      new Request(`${ISSUER}${path}`, { headers: { accept: HYPERMEDIA } }),
    );
    assert.equal(response?.status, 200);
    const body = await response!.text();
    assert.equal(body.includes("/admin/clients"), false);
    assert.equal(body.includes(BROWSER_SESSION_CLIENT_ID), false);
  }

  const rootHtml = await app.fetch(
    new Request(ISSUER, { headers: { accept: "text/html" } }),
  );
  assert.equal(rootHtml?.status, 200);
  assert.doesNotMatch(await rootHtml!.text(), /href="\/admin\/clients"/);

  const sessionHtml = await app.fetch(
    new Request(`${ISSUER}/session`, { headers: { accept: "text/html" } }),
  );
  assert.equal(sessionHtml?.status, 200);
  assert.doesNotMatch(await sessionHtml!.text(), /href="\/admin\/clients"/);

  const recordsHtml = await app.fetch(
    new Request(`${ISSUER}/storage/records`, {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(recordsHtml?.status, 200);
  const recordsBody = await recordsHtml!.text();
  assert.match(recordsBody, /Current signed-in session/);
  assert.equal(recordsBody.includes(BROWSER_SESSION_CLIENT_ID), false);
});

test("enabled OAuth Apps exposes allowlisted administration without the reserved client", async () => {
  const store = new MemoryAuthStore();
  const user = await store.findOrCreateUser(ADMIN_IDENTITY, nowSeconds());
  const env = await testEnv({
    FEATURE_OAUTH_APPS_ENABLED: "true",
    ADMIN_SUBJECTS: user.id,
  });
  const app = createTestAittaDB(env, store, ADMIN_IDENTITY);

  const root = await app.fetch(
    new Request(ISSUER, { headers: { accept: HYPERMEDIA } }),
  );
  assert.equal(root?.status, 200);
  assert.match(await root!.text(), /\/admin\/clients/);

  const administration = await app.fetch(
    new Request(`${ISSUER}/admin/clients`, {
      headers: { accept: HYPERMEDIA },
    }),
  );
  assert.equal(administration?.status, 200);
  const body = await administration!.text();
  assert.equal(body.includes(BROWSER_SESSION_CLIENT_ID), false);
});

test("OpenAPI documents the OAuth Apps administration gate", () => {
  const path = openApiSpec.paths["/admin/clients"];
  for (const operation of [path.get, path.post]) {
    assert.match(operation.description, /FEATURE_OAUTH_APPS_ENABLED/);
    assert.ok("503" in operation.responses);
    assert.match(operation.responses["503"].description, /disabled/);
    assert.match(
      operation.responses["503"].description,
      /before Sites identity/,
    );
    assert.match(
      operation.responses["503"].description,
      /reserved current-session client/,
    );
  }
});

function observeRepositoryCalls(target: MemoryAuthStore): {
  store: AuthStore;
  calls: string[];
} {
  const calls: string[] = [];
  const store = new Proxy(target, {
    get(current, property) {
      const value = Reflect.get(current, property, current) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return Reflect.apply(value, current, args) as unknown;
      };
    },
  }) as AuthStore;
  return { store, calls };
}
