import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { nowSeconds, sha256 } from "../../src/crypto";
import { createClientRegistration, issueTokens } from "../../src/oauth";
import { MemoryAuthStore } from "../../src/store/memory";
import { BROWSER_SESSION_CLIENT_ID } from "../../src/system-client";
import type {
  AppConfig,
  ClientView,
  LocalUser,
  RuntimeEnv,
} from "../../src/types";
import { cookieValue, createTestAittaDB, form, testEnv } from "../helpers";

interface StorageFixture {
  app: ReturnType<typeof createTestAittaDB>;
  store: MemoryAuthStore;
  env: RuntimeEnv;
  config: AppConfig;
  user: LocalUser;
  client: ClientView;
  accessToken: string;
}

test("storage quotas reject excess writes, expose only namespace usage, and free capacity on delete", async () => {
  const fixture = await storageFixture({
    STORAGE_NAMESPACE_MAX_ITEMS: "2",
    STORAGE_NAMESPACE_MAX_BYTES: "1024",
    STORAGE_USER_MAX_ITEMS: "2",
    STORAGE_USER_MAX_BYTES: "1024",
    STORAGE_GLOBAL_MAX_ITEMS: "2",
    STORAGE_GLOBAL_MAX_BYTES: "1024",
  });
  assert.equal((await putRecord(fixture, "alpha", { order: 1 })).status, 200);
  assert.equal((await putRecord(fixture, "beta", { order: 2 })).status, 200);

  const rejected = await putRecord(fixture, "gamma", { order: 3 });
  assert.equal(rejected.status, 507);
  assert.equal(
    ((await rejected.json()) as { error: string }).error,
    "storage_limit_exceeded",
  );

  const collection = await storageRequest(
    fixture,
    "/storage/records?page_size=1",
  );
  const document = (await collection.json()) as {
    data: {
      count: number;
      has_more: boolean;
      usage: {
        item_count: number;
        item_limit: number;
        byte_count: number;
      };
      items: Array<{ data: { key: string } }>;
    };
    links: Array<{ rel: string[]; href: string }>;
  };
  assert.equal(document.data.count, 1);
  assert.equal(document.data.has_more, true);
  assert.equal(document.data.usage.item_count, 2);
  assert.equal(document.data.usage.item_limit, 2);
  assert.ok(document.data.usage.byte_count > 0);
  const next = document.links.find((candidate) =>
    candidate.rel.includes("next"),
  )?.href;
  assert.ok(next);

  const secondPage = (await (await storageRequest(fixture, next)).json()) as {
    data: { items: Array<{ data: { key: string } }>; has_more: boolean };
  };
  assert.equal(secondPage.data.items.length, 1);
  assert.equal(secondPage.data.has_more, false);
  assert.notEqual(
    secondPage.data.items[0]?.data.key,
    document.data.items[0]?.data.key,
  );

  assert.equal(
    (
      await storageRequest(fixture, "/storage/records/alpha", {
        method: "DELETE",
      })
    ).status,
    200,
  );
  assert.equal((await putRecord(fixture, "gamma", { order: 3 })).status, 200);
});

test("storage cursors cannot cross OAuth client namespaces", async () => {
  const fixture = await storageFixture();
  await putRecord(fixture, "alpha", 1);
  await putRecord(fixture, "beta", 2);
  const first = (await (
    await storageRequest(fixture, "/storage/records?page_size=1")
  ).json()) as { links: Array<{ rel: string[]; href: string }> };
  const next = first.links.find((link) => link.rel.includes("next"))?.href;
  assert.ok(next);

  const otherRegistration = await createClientRegistration(
    {
      type: "public",
      name: "Other namespace",
      redirectUris: ["https://other.example.test/callback"],
      scopes: ["storage.read"],
      origins: [],
    },
    fixture.store,
    nowSeconds(),
  );
  const otherTokens = await issueTokens({
    config: fixture.config,
    store: fixture.store,
    user: fixture.user,
    client: otherRegistration.client,
    scope: "storage.read",
    includeRefresh: false,
    now: nowSeconds(),
  });
  const response = await fixture.app.fetch(
    new Request(next, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${String(otherTokens.access_token)}`,
      },
    }),
  );
  assert.equal(response?.status, 400);
  assert.equal(
    ((await response!.json()) as { error: string }).error,
    "invalid_request",
  );
});

test("signed-in HTML storage renders bounded usage and a next-page control", async () => {
  const env = await testEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const user = await store.findOrCreateUser(
    {
      email: "user@example.test",
      fullName: "Test User",
      displayName: "Test User",
    },
    nowSeconds(),
  );
  for (const [key, updatedAt] of [
    ["alpha", 2],
    ["beta", 1],
  ] as const) {
    assert.equal(
      await store.upsertStorageRecord(
        {
          userId: user.id,
          clientId: BROWSER_SESSION_CLIENT_ID,
          key,
          valueJson: JSON.stringify({ key }),
          createdAt: updatedAt,
          updatedAt,
        },
        config.storageLimits,
      ),
      true,
    );
  }
  const response = await createTestAittaDB(env, store).fetch(
    new Request("https://aittadb.example.test/storage/records?page_size=1", {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(response?.status, 200);
  const page = await response!.text();
  assert.match(page, /1 record on this page/);
  assert.match(page, /This namespace uses 2 of 500 items/);
  assert.match(page, /Next page/);
  assert.match(page, /page_size=1&amp;cursor=/);
});

test("the storage kill switch blocks create and replace but leaves deletes available", async () => {
  const env = await testEnv({ STORAGE_WRITES_ENABLED: "false" });
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const user = await store.findOrCreateUser(
    {
      email: "kill-switch@example.test",
      fullName: "Kill Switch",
      displayName: "Kill Switch",
    },
    nowSeconds(),
  );
  const registration = await createClientRegistration(
    {
      type: "public",
      name: "Kill Switch Client",
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["storage.read", "storage.write", "storage.delete"],
      origins: [],
    },
    store,
    nowSeconds(),
  );
  await store.upsertStorageRecord(
    {
      userId: user.id,
      clientId: registration.client.id,
      key: "existing",
      valueJson: "true",
      createdAt: 1,
      updatedAt: 1,
    },
    { ...config.storageLimits, writesEnabled: true },
  );
  const accessToken = String(
    (
      await issueTokens({
        config,
        store,
        user,
        client: registration.client,
        scope: "storage.read storage.write storage.delete",
        includeRefresh: false,
        now: nowSeconds(),
      })
    ).access_token,
  );
  const fixture: StorageFixture = {
    app: createTestAittaDB(env, store),
    store,
    env,
    config,
    user,
    client: registration.client,
    accessToken,
  };
  const blocked = await putRecord(fixture, "new", true);
  assert.equal(blocked.status, 503);
  assert.equal(
    ((await blocked.json()) as { error: string }).error,
    "storage_writes_disabled",
  );
  assert.equal(
    (
      await storageRequest(fixture, "/storage/records/existing", {
        method: "DELETE",
      })
    ).status,
    200,
  );
});

test("storage read and write limits are enforced per authenticated namespace", async () => {
  const fixture = await storageFixture({
    STORAGE_READ_RATE_LIMIT: "2",
    STORAGE_WRITE_RATE_LIMIT: "2",
  });
  assert.equal((await putRecord(fixture, "one", 1)).status, 200);
  assert.equal((await putRecord(fixture, "two", 2)).status, 200);
  const writeLimited = await putRecord(fixture, "three", 3);
  assert.equal(writeLimited.status, 429);
  assert.equal(writeLimited.headers.get("retry-after"), "60");

  assert.equal((await storageRequest(fixture, "/storage/records")).status, 200);
  assert.equal(
    (await storageRequest(fixture, "/storage/records/one")).status,
    200,
  );
  const readLimited = await storageRequest(fixture, "/storage/records");
  assert.equal(readLimited.status, 429);
  assert.equal(readLimited.headers.get("retry-after"), "60");
});

test("client origins drive CORS and disabled clients invalidate UserInfo", async () => {
  const fixture = await storageFixture(
    {},
    ["openid", "email", "storage.read"],
    ["https://allowed.example.test"],
  );
  const allowed = await fixture.app.fetch(
    new Request("https://aittadb.example.test/userinfo", {
      headers: {
        authorization: `Bearer ${fixture.accessToken}`,
        origin: "https://allowed.example.test",
      },
    }),
  );
  assert.equal(allowed?.status, 200);
  assert.equal(
    allowed?.headers.get("access-control-allow-origin"),
    "https://allowed.example.test",
  );

  const preflight = await fixture.app.fetch(
    new Request("https://aittadb.example.test/userinfo", {
      method: "OPTIONS",
      headers: { origin: "https://allowed.example.test" },
    }),
  );
  assert.equal(preflight?.status, 204);
  assert.equal(
    preflight?.headers.get("access-control-allow-origin"),
    "https://allowed.example.test",
  );

  const foreign = await fixture.app.fetch(
    new Request("https://aittadb.example.test/userinfo", {
      headers: {
        authorization: `Bearer ${fixture.accessToken}`,
        origin: "https://foreign.example.test",
      },
    }),
  );
  assert.equal(foreign?.status, 403);

  await fixture.store.setClientDisabled(fixture.client.id, nowSeconds());
  const disabled = await fixture.app.fetch(
    new Request("https://aittadb.example.test/userinfo", {
      headers: { authorization: `Bearer ${fixture.accessToken}` },
    }),
  );
  assert.equal(disabled?.status, 401);
});

test("token CORS is client-bound and rejects foreign origins before code consumption", async () => {
  const allowedOrigin = "https://allowed.example.test";
  const foreignOrigin = "https://foreign.example.test";
  const fixture = await storageFixture({}, ["openid"], [allowedOrigin]);
  const verifier = "v".repeat(43);
  const code = "one-time-authorization-code";
  const codeHash = await sha256(code);
  const now = nowSeconds();
  await fixture.store.createAuthorizationRequest({
    id: "cors-auth-request",
    clientId: fixture.client.id,
    redirectUri: "https://client.example.test/callback",
    scope: "openid",
    state: "state",
    nonce: "nonce",
    codeChallenge: await sha256(verifier),
    createdAt: now,
    expiresAt: now + 300,
    userId: fixture.user.id,
    status: "approved",
  });
  await fixture.store.createAuthorizationCode({
    codeHash,
    authRequestId: "cors-auth-request",
    clientId: fixture.client.id,
    redirectUri: "https://client.example.test/callback",
    userId: fixture.user.id,
    scope: "openid",
    nonce: "nonce",
    expiresAt: now + 300,
    consumedAt: null,
  });

  const preflight = await fixture.app.fetch(
    new Request(`${fixture.config.issuerUrl}/oauth/token`, {
      method: "OPTIONS",
      headers: { origin: allowedOrigin },
    }),
  );
  assert.equal(preflight?.status, 204);
  assert.equal(
    preflight?.headers.get("access-control-allow-origin"),
    allowedOrigin,
  );

  const tokenBody = form({
    grant_type: "authorization_code",
    client_id: fixture.client.id,
    code,
    redirect_uri: "https://client.example.test/callback",
    code_verifier: verifier,
  });
  const foreign = await fixture.app.fetch(
    new Request(`${fixture.config.issuerUrl}/oauth/token`, {
      method: "POST",
      headers: {
        origin: foreignOrigin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: tokenBody,
    }),
  );
  assert.equal(foreign?.status, 403);
  assert.equal(fixture.store.authCodes.get(codeHash)?.consumedAt, null);
  assert.equal(fixture.store.counters.get("token:global")?.count, 1);

  const allowed = await fixture.app.fetch(
    new Request(`${fixture.config.issuerUrl}/oauth/token`, {
      method: "POST",
      headers: {
        origin: allowedOrigin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: tokenBody,
    }),
  );
  assert.equal(allowed?.status, 200);
  assert.equal(
    allowed?.headers.get("access-control-allow-origin"),
    allowedOrigin,
  );
  assert.equal(
    typeof ((await allowed!.json()) as { access_token: unknown }).access_token,
    "string",
  );
});

test("production HTTPS responses include HSTS while test HTTP responses do not", async () => {
  const production = await testEnv({
    NODE_ENV: "production",
    DB: {} as D1Database,
  });
  const productionResponse = await createTestAittaDB(
    production,
    new MemoryAuthStore(),
  ).fetch(new Request("https://aittadb.example.test/health"));
  assert.equal(
    productionResponse?.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains",
  );

  const local = await testEnv();
  const localResponse = await createTestAittaDB(
    local,
    new MemoryAuthStore(),
  ).fetch(new Request("http://localhost/health"));
  assert.equal(localResponse?.headers.get("strict-transport-security"), null);
});

test("administration uses the signed-in allowlisted subject and audits mutations", async () => {
  const baseEnv = await testEnv();
  const store = new MemoryAuthStore();
  const identity = {
    email: "admin@example.test",
    fullName: "Admin User",
    displayName: "Admin User",
  };
  const user = await store.findOrCreateUser(identity, nowSeconds());
  const env = { ...baseEnv, ADMIN_SUBJECTS: user.id };
  const app = createTestAittaDB(env, store, identity);
  const clients = await app.fetch(
    new Request("https://aittadb.example.test/admin/clients", {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(clients?.status, 200);
  const clientsHtml = await clients!.text();
  assert.match(clientsHtml, /Create client/);
  assert.doesNotMatch(clientsHtml, /Unlock AittaDB administration/);
  assert.doesNotMatch(clientsHtml, /Administrator access key/);

  const clientsCsrf = cookieValue(clients!, "aittadb_csrf");
  const submissionToken = clientsHtml.match(
    /name="submission_token" value="([^"]+)"/,
  )?.[1];
  assert.match(submissionToken ?? "", /^[A-Za-z0-9_-]{32}$/);
  const created = await app.fetch(
    new Request("https://aittadb.example.test/admin/clients", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${clientsCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        csrf_token: clientsCsrf,
        submission_token: submissionToken!,
        name: "Audited client",
        type: "public",
        redirect_uris: "https://client.example.test/callback",
        scopes: "openid",
        origins: "https://client.example.test",
      }),
    }),
  );
  assert.equal(created?.status, 303);
  assert.equal(created?.headers.get("location"), "/admin/clients");
  const mutationAudit = store.audits.at(-1);
  assert.equal(mutationAudit?.type, "admin.client.mutated");
  assert.equal(mutationAudit?.data.action, "create");
  assert.match(String(mutationAudit?.data.client_reference), /^[\w-]{43}$/);
  assert.match(String(mutationAudit?.data.actor_subject_hash), /^[\w-]{43}$/);
  assert.equal(mutationAudit?.data.identity_source, "subject");

  const home = await app.fetch(
    new Request("https://aittadb.example.test/", {
      headers: { accept: "text/html" },
    }),
  );
  assert.match(await home!.text(), /Application clients/);
});

test("administration denies anonymous and unlisted identities without exposing controls", async () => {
  const baseEnv = await testEnv();
  const store = new MemoryAuthStore();
  const identity = {
    email: "subject-admin@example.test",
    fullName: "Subject Admin",
    displayName: "Subject Admin",
  };
  const user = await store.findOrCreateUser(identity, nowSeconds());
  const env = { ...baseEnv, ADMIN_SUBJECTS: user.id };
  const app = createTestAittaDB(env, store, identity);
  const allowed = await app.fetch(
    new Request("https://aittadb.example.test/admin/clients", {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(allowed?.status, 200);
  assert.match(await allowed!.text(), /Create client/);
  const session = await app.fetch(
    new Request("https://aittadb.example.test/session", {
      headers: { accept: "text/html" },
    }),
  );
  assert.match(await session!.text(), /Application clients/);

  const otherIdentity = {
    email: "other@example.test",
    fullName: "Subject Admin",
    displayName: "Subject Admin",
  };
  const denied = await createTestAittaDB(env, store, otherIdentity).fetch(
    new Request("https://aittadb.example.test/admin/clients"),
  );
  assert.equal(denied?.status, 403);
  const deniedBody = await denied!.text();
  assert.doesNotMatch(
    deniedBody,
    /Create OAuth client|redirect_uris|client_id/,
  );

  const anonymous = await createTestAittaDB(env, store, null).fetch(
    new Request("https://aittadb.example.test/admin/clients", {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(anonymous?.status, 302);
  assert.match(
    anonymous?.headers.get("location") ?? "",
    /\/signin-with-chatgpt\?return_to=/,
  );
});

test("administrator allowlisting retains the documented upstream email reassignment risk", async () => {
  const baseEnv = await testEnv();
  const store = new MemoryAuthStore();
  const originalIdentity = {
    email: "reassigned@example.test",
    fullName: "Original Person",
    displayName: "Original Person",
  };
  const original = await store.findOrCreateUser(originalIdentity, nowSeconds());
  const env = { ...baseEnv, ADMIN_SUBJECTS: original.id };
  const reassignedIdentity = {
    email: originalIdentity.email,
    fullName: "Different Person",
    displayName: "Different Person",
  };
  const reassigned = await store.findOrCreateUser(
    reassignedIdentity,
    nowSeconds(),
  );
  assert.equal(reassigned.id, original.id);
  const response = await createTestAittaDB(
    env,
    store,
    reassignedIdentity,
  ).fetch(new Request("https://aittadb.example.test/admin/clients"));
  assert.equal(response?.status, 200);
});

test("anonymous authorization request creation is rate limited and cleaned up", async () => {
  const env = await testEnv();
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);
  const registration = await createClientRegistration(
    {
      type: "public",
      name: "Rate Limited Client",
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["openid"],
      origins: [],
    },
    store,
    nowSeconds(),
  );
  const challenge = await sha256(
    "rate-limit-verifier-with-at-least-forty-three-characters",
  );
  const authorizeUrl = new URL("https://aittadb.example.test/authorize");
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: registration.client.id,
    redirect_uri: registration.client.redirectUris[0]!,
    scope: "openid",
    state: "state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await app.fetch(
      new Request(authorizeUrl, {
        headers: { "cf-connecting-ip": "192.0.2.10" },
      }),
    );
    assert.equal(response?.status, 302);
  }
  const blocked = await app.fetch(
    new Request(authorizeUrl, {
      headers: { "cf-connecting-ip": "192.0.2.10" },
    }),
  );
  assert.equal(blocked?.status, 429);
  assert.equal(store.authRequests.size, 30);
  assert.equal(store.counters.get("authorize:global")?.count, 30);
  const privateScalar = String(
    (JSON.parse(env.JWT_PRIVATE_JWK!) as JsonWebKey).d,
  );
  for (const key of store.counters.keys()) {
    assert.equal(key.includes("192.0.2.10"), false);
    assert.equal(key.includes(privateScalar), false);
  }
  await store.cleanup(nowSeconds() + 600);
  assert.equal(store.authRequests.size, 0);
});

async function storageFixture(
  extraEnv: Partial<RuntimeEnv> = {},
  scopes: string[] = ["storage.read", "storage.write", "storage.delete"],
  origins: string[] = [],
): Promise<StorageFixture> {
  const env = await testEnv(extraEnv);
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const user = await store.findOrCreateUser(
    {
      email: "storage-controls@example.test",
      fullName: "Storage Controls",
      displayName: "Storage Controls",
    },
    nowSeconds(),
  );
  const registration = await createClientRegistration(
    {
      type: "public",
      name: "Storage Controls Client",
      redirectUris: ["https://client.example.test/callback"],
      scopes,
      origins,
    },
    store,
    nowSeconds(),
  );
  const tokens = await issueTokens({
    config,
    store,
    user,
    client: registration.client,
    scope: scopes.join(" "),
    includeRefresh: false,
    now: nowSeconds(),
  });
  return {
    app: createTestAittaDB(env, store),
    store,
    env,
    config,
    user,
    client: registration.client,
    accessToken: String(tokens.access_token),
  };
}

function storageRequest(
  fixture: StorageFixture,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return requiredResponse(
    fixture.app.fetch(
      new Request(new URL(path, fixture.config.issuerUrl), {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${fixture.accessToken}`,
          ...Object.fromEntries(new Headers(init.headers).entries()),
        },
      }),
    ),
  );
}

function putRecord(
  fixture: StorageFixture,
  key: string,
  value: unknown,
): Promise<Response> {
  return storageRequest(
    fixture,
    `/storage/records/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    },
  );
}

async function requiredResponse(
  response: Promise<Response | null>,
): Promise<Response> {
  const resolved = await response;
  assert.ok(resolved);
  return resolved;
}
