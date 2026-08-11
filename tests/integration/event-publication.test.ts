import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { nowSeconds } from "../../src/crypto";
import {
  APPLICATION_EVENT_IDEMPOTENCY_KEY_MAX_LENGTH,
  APPLICATION_EVENT_JSON_MAX_BYTES,
} from "../../src/event-publication";
import type { HypermediaDocument } from "../../src/hypermedia";
import {
  createClientRegistration,
  issueClientCredentialsToken,
  issueTokens,
} from "../../src/oauth";
import { MemoryAuthStore } from "../../src/store/memory";
import { BROWSER_SESSION_CLIENT_ID } from "../../src/system-client";
import type {
  AppConfig,
  AuthStore,
  ClientView,
  LocalUser,
  RuntimeEnv,
  UpstreamIdentity,
} from "../../src/types";
import {
  cookieValue,
  createTestAittaDB,
  form,
  testEnv,
  testIdentityProvider,
} from "../helpers";
import { createAittaDBWithStore } from "../../src/handler";

const ISSUER = "https://aittadb.example.test";
const CLIENT_ORIGIN = "https://events-client.example.test";
const HYPERMEDIA = "application/vnd.aittadb+json; version=0.1";
const IDENTITY: UpstreamIdentity = {
  email: "publisher@example.test",
  fullName: "Event Publisher",
  displayName: "Event Publisher",
};
const OTHER_IDENTITY: UpstreamIdentity = {
  email: "other-publisher@example.test",
  fullName: "Other Publisher",
  displayName: "Other Publisher",
};

interface EventRepresentation {
  id: string;
  type: string;
  data: Record<string, unknown>;
  created_at: number;
  expires_at: number;
}

interface Fixture {
  env: RuntimeEnv;
  config: AppConfig;
  store: MemoryAuthStore;
  app: ReturnType<typeof createTestAittaDB>;
  user: LocalUser;
  client: ClientView;
  token: string;
}

test("bearer publication creates once, replays exactly, and conflicts deterministically", async () => {
  const fixture = await publicationFixture();
  const first = await publish(fixture, {
    idempotencyKey: "create-order-42",
    data: { order: 42, ready: true },
  });
  assert.equal(first.status, 201);
  assert.match(
    first.headers.get("location") ?? "",
    /^https:\/\/aittadb\.example\.test\/events\/[0-9a-f-]{36}$/,
  );
  assert.equal(first.headers.get("idempotency-replayed"), null);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.match(first.headers.get("content-type") ?? "", /vnd\.aittadb\+json/);

  const firstDocument =
    (await first.json()) as HypermediaDocument<EventRepresentation>;
  assert.equal(firstDocument.type, "application-event");
  assert.deepEqual(firstDocument.data.data, { order: 42, ready: true });
  assert.equal(firstDocument.data.type, "orders.ready");
  assert.deepEqual(Object.keys(firstDocument.data).sort(), [
    "created_at",
    "data",
    "expires_at",
    "id",
    "type",
  ]);
  assert.equal(firstDocument.id, firstDocument.data.id);
  assert.equal(
    firstDocument.links.some((item) => item.rel.includes("self")),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(firstDocument),
    /clientId|client_id|userId|user_id|sequence|requestHash|idempotencyKeyHash|access_token/,
  );

  const replay = await publish(fixture, {
    idempotencyKey: "create-order-42",
    data: { order: 42, ready: true },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.equal(replay.headers.get("location"), first.headers.get("location"));
  const replayDocument =
    (await replay.json()) as HypermediaDocument<EventRepresentation>;
  assert.deepEqual(replayDocument.data, firstDocument.data);

  const conflict = await publish(fixture, {
    idempotencyKey: "create-order-42",
    data: { order: 43, ready: true },
  });
  assert.equal(conflict.status, 409);
  assert.equal(await errorCode(conflict), "idempotency_conflict");
  assert.equal(
    await eventCount(fixture.store, fixture.user.id, fixture.client.id),
    1,
  );
});

test("publication derives isolated human and service namespaces only from verified access tokens", async () => {
  const fixture = await publicationFixture();
  const secondClient = await registerClient(
    fixture.store,
    "Second Events client",
  );
  const secondClientToken = await humanToken(
    fixture.config,
    fixture.store,
    fixture.user,
    secondClient,
    "events.publish",
  );
  const otherUser = await fixture.store.findOrCreateUser(
    OTHER_IDENTITY,
    nowSeconds(),
  );
  const otherUserToken = await humanToken(
    fixture.config,
    fixture.store,
    otherUser,
    fixture.client,
    "events.publish",
  );
  const serviceRegistration = await createClientRegistration(
    {
      type: "service",
      name: "Event service",
      redirectUris: [],
      scopes: ["events.publish"],
      origins: [],
    },
    fixture.store,
    nowSeconds(),
    { eventsEnabled: true },
  );
  const serviceTokenResponse = await issueClientCredentialsToken({
    config: fixture.config,
    store: fixture.store,
    client: serviceRegistration.client,
    requestedScope: "events.publish",
    now: nowSeconds(),
  });
  const serviceToken = String(
    ((await serviceTokenResponse.json()) as { access_token: string })
      .access_token,
  );

  const cases = [
    [fixture.token, fixture.user.id, fixture.client.id],
    [secondClientToken, fixture.user.id, secondClient.id],
    [otherUserToken, otherUser.id, fixture.client.id],
    [
      serviceToken,
      serviceRegistration.client.id,
      serviceRegistration.client.id,
    ],
  ] as const;
  const ids = new Set<string>();
  for (const [token, userId, clientId] of cases) {
    const response = await publish(fixture, {
      token,
      idempotencyKey: "same-key-in-every-namespace",
      data: { source: "isolated" },
    });
    assert.equal(response.status, 201);
    const document =
      (await response.json()) as HypermediaDocument<EventRepresentation>;
    ids.add(document.data.id);
    assert.equal(await eventCount(fixture.store, userId, clientId), 1);
  }
  assert.equal(ids.size, cases.length);

  const attemptedOverride = await publish(fixture, {
    rawBody: JSON.stringify({
      type: "orders.ready",
      data: {},
      user_id: otherUser.id,
      client_id: secondClient.id,
    }),
  });
  assert.equal(attemptedOverride.status, 400);
  assert.equal(
    await eventCount(fixture.store, fixture.user.id, fixture.client.id),
    1,
  );
});

test("publication rejects malformed type, payload, top-level fields, and idempotency keys without appending", async () => {
  const fixture = await publicationFixture();
  const cases: Array<{
    name: string;
    body: string;
    idempotencyKey?: string;
    status?: number;
  }> = [
    { name: "missing type", body: JSON.stringify({ data: {} }) },
    {
      name: "invalid type",
      body: JSON.stringify({ type: "not a type", data: {} }),
    },
    {
      name: "array data",
      body: JSON.stringify({ type: "orders.ready", data: [] }),
    },
    {
      name: "unknown field",
      body: JSON.stringify({ type: "orders.ready", data: {}, owner: "x" }),
    },
    {
      name: "oversized data",
      body: JSON.stringify({
        type: "orders.ready",
        data: { value: "x".repeat(65_536) },
      }),
      status: 413,
    },
    {
      name: "space in key",
      body: JSON.stringify({ type: "orders.ready", data: {} }),
      idempotencyKey: "not valid",
    },
    {
      name: "long key",
      body: JSON.stringify({ type: "orders.ready", data: {} }),
      idempotencyKey: "k".repeat(
        APPLICATION_EVENT_IDEMPOTENCY_KEY_MAX_LENGTH + 1,
      ),
    },
    { name: "malformed JSON", body: "{" },
  ];

  for (const item of cases) {
    const response = await publish(fixture, {
      rawBody: item.body,
      idempotencyKey: item.idempotencyKey,
    });
    assert.equal(response.status, item.status ?? 400, item.name);
    assert.equal(await errorCode(response), "invalid_request", item.name);
  }
  assert.equal(
    await eventCount(fixture.store, fixture.user.id, fixture.client.id),
    0,
  );

  const unsupported = await fixture.app.fetch(
    new Request(`${ISSUER}/events`, {
      method: "POST",
      headers: {
        accept: HYPERMEDIA,
        authorization: `Bearer ${fixture.token}`,
        "content-type": "text/plain",
      },
      body: "not-json",
    }),
  );
  assert.equal(unsupported?.status, 415);
  assert.equal(
    await eventCount(fixture.store, fixture.user.id, fixture.client.id),
    0,
  );
});

test("publication enforces token purpose, scope, active client, and active subject", async () => {
  const missing = await publicationFixture();
  assert.equal((await publish(missing, { token: null })).status, 401);

  const wrongScope = await publicationFixture({
    clientScopes: ["storage.read"],
    tokenScope: "storage.read",
  });
  assert.equal((await publish(wrongScope)).status, 403);

  const idTokenFixture = await publicationFixture({
    clientScopes: ["openid", "events.publish"],
    tokenScope: "openid events.publish",
  });
  const tokenSet = await issueTokens({
    config: idTokenFixture.config,
    store: idTokenFixture.store,
    user: idTokenFixture.user,
    client: idTokenFixture.client,
    scope: "openid events.publish",
    includeRefresh: false,
    now: nowSeconds(),
  });
  assert.equal(
    (await publish(idTokenFixture, { token: String(tokenSet.id_token) }))
      .status,
    401,
  );

  const disabled = await publicationFixture();
  await disabled.store.setClientDisabled(disabled.client.id, nowSeconds());
  assert.equal((await publish(disabled)).status, 401);

  const deleting = await publicationFixture();
  await deleting.store.startAccountDeletionJob(deleting.user.id, nowSeconds());
  assert.equal((await publish(deleting)).status, 401);

  for (const fixture of [
    missing,
    wrongScope,
    idTokenFixture,
    disabled,
    deleting,
  ]) {
    assert.equal(
      await eventCount(fixture.store, fixture.user.id, fixture.client.id),
      0,
    );
  }
});

test("bearer CORS permits only the active client's exact origin and exposes publication headers", async () => {
  const fixture = await publicationFixture();
  const preflight = await fixture.app.fetch(
    new Request(`${ISSUER}/events`, {
      method: "OPTIONS",
      headers: {
        origin: CLIENT_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers":
          "authorization,content-type,idempotency-key",
      },
    }),
  );
  assert.equal(preflight?.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    CLIENT_ORIGIN,
  );
  assert.match(
    preflight.headers.get("access-control-allow-headers") ?? "",
    /idempotency-key/,
  );

  const allowed = await publish(fixture, {
    origin: CLIENT_ORIGIN,
    idempotencyKey: "cors-publication",
  });
  assert.equal(allowed.status, 201);
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    CLIENT_ORIGIN,
  );
  assert.match(
    allowed.headers.get("access-control-expose-headers") ?? "",
    /location/,
  );
  assert.doesNotMatch(
    allowed.headers.get("access-control-allow-origin") ?? "",
    /\*/,
  );

  const rejected = await publish(fixture, {
    origin: "https://foreign.example.test",
    data: { should: "not append" },
  });
  assert.equal(rejected.status, 403);
  assert.equal(
    await eventCount(fixture.store, fixture.user.id, fixture.client.id),
    1,
  );
});

test("signed-in HTML and hypermedia forms use CSRF and never expose the internal session token", async () => {
  const env = await testEnv({ FEATURE_EVENTS_ENABLED: "true" });
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store, IDENTITY);
  const page = await app.fetch(
    new Request(`${ISSUER}/events`, { headers: { accept: "text/html" } }),
  );
  assert.equal(page?.status, 200);
  const pageHtml = await page.text();
  const csrf = cookieValue(page, "aittadb_csrf");
  assert.match(pageHtml, /<form method="post" action="\/events"/);
  assert.match(pageHtml, /name="csrf_token"/);
  assert.doesNotMatch(pageHtml, /access_token|Bearer |eyJ[A-Za-z0-9_-]+\./);

  const publication = await app.fetch(
    new Request(`${ISSUER}/events`, {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${csrf}`,
        origin: ISSUER,
      },
      body: form({
        csrf_token: csrf,
        type: "browser.saved",
        data: JSON.stringify({ source: "browser" }),
        idempotency_key: "browser-save",
      }),
    }),
  );
  assert.equal(publication?.status, 201);
  assert.match(publication.headers.get("content-type") ?? "", /text\/html/);
  const resultHtml = await publication.text();
  assert.match(resultHtml, /Event published/);
  assert.match(resultHtml, /browser\.saved/);
  assert.doesNotMatch(resultHtml, /access_token|Bearer |eyJ[A-Za-z0-9_-]+\./);

  const replay = await app.fetch(
    new Request(`${ISSUER}/events`, {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${csrf}`,
        origin: ISSUER,
      },
      body: form({
        csrf_token: csrf,
        type: "browser.saved",
        data: JSON.stringify({ source: "browser" }),
        idempotency_key: "browser-save",
      }),
    }),
  );
  assert.equal(replay?.status, 200);
  assert.match(await replay.text(), /Existing event returned/);

  const user = await store.getUserByEmail(IDENTITY.email);
  assert.ok(user);
  assert.equal(await eventCount(store, user.id, BROWSER_SESSION_CLIENT_ID), 1);

  const descriptor = await app.fetch(
    new Request(`${ISSUER}/events`, { headers: { accept: HYPERMEDIA } }),
  );
  assert.equal(descriptor?.status, 200);
  const serialized = JSON.stringify(await descriptor.json());
  assert.match(serialized, /publish-event/);
  assert.doesNotMatch(serialized, /access_token|Bearer |eyJ[A-Za-z0-9_-]+\./);
});

test("browser publication rejects foreign origin, bad CSRF, and polluted forms before repository work", async () => {
  const env = await testEnv({ FEATURE_EVENTS_ENABLED: "true" });
  const observed = observeStore(new MemoryAuthStore());
  const app = createAittaDBWithStore(
    env,
    observed.store,
    undefined,
    undefined,
    testIdentityProvider(IDENTITY),
  );
  const csrf = "c".repeat(32);
  const validBody = {
    csrf_token: csrf,
    type: "browser.saved",
    data: "{}",
  };

  const foreign = await app.fetch(
    browserRequest(validBody, csrf, "https://foreign.example.test"),
  );
  assert.equal(foreign?.status, 403);
  assert.deepEqual(observed.calls, []);

  const badCsrf = await app.fetch(
    browserRequest(
      { ...validBody, csrf_token: "x".repeat(32) },
      csrf,
      ISSUER,
      "text/html",
    ),
  );
  assert.equal(badCsrf?.status, 403);
  assert.match(badCsrf?.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await badCsrf!.text(), /CSRF validation failed/);
  assert.deepEqual(observed.calls, []);

  const polluted = await app.fetch(
    browserRequest({ ...validBody, unexpected: "value" }, csrf, ISSUER),
  );
  assert.equal(polluted?.status, 400);
  assert.deepEqual(observed.calls, []);
});

test("publication rate and quota controls fail closed without duplicate admission", async () => {
  const rateLimited = await publicationFixture({
    env: { EVENTS_PUBLISH_RATE_LIMIT: "1" },
  });
  assert.equal((await publish(rateLimited)).status, 201);
  const rateResponse = await publish(rateLimited, {
    data: { second: true },
  });
  assert.equal(rateResponse.status, 429);
  assert.equal(rateResponse.headers.get("retry-after"), "60");
  assert.equal(
    await eventCount(
      rateLimited.store,
      rateLimited.user.id,
      rateLimited.client.id,
    ),
    1,
  );
  for (const key of rateLimited.store.counters.keys()) {
    assert.equal(key.includes(rateLimited.user.id), false);
    assert.equal(key.includes(rateLimited.client.id), false);
    assert.equal(key.includes(rateLimited.user.email), false);
  }

  const quotaLimited = await publicationFixture({
    env: { EVENTS_NAMESPACE_MAX_ITEMS: "1" },
  });
  const created = await publish(quotaLimited, {
    idempotencyKey: "quota-safe-retry",
  });
  assert.equal(created.status, 201);
  const replay = await publish(quotaLimited, {
    idempotencyKey: "quota-safe-retry",
  });
  assert.equal(replay.status, 200);
  const rejected = await publish(quotaLimited, {
    idempotencyKey: "quota-overflow",
    data: { second: true },
  });
  assert.equal(rejected.status, 507);
  assert.equal(await errorCode(rejected), "event_limit_exceeded");
  assert.equal(
    await eventCount(
      quotaLimited.store,
      quotaLimited.user.id,
      quotaLimited.client.id,
    ),
    1,
  );
});

test("event publication request constants remain finite and configurable rates fail closed", async () => {
  assert.ok(APPLICATION_EVENT_JSON_MAX_BYTES > 65_536);
  assert.ok(APPLICATION_EVENT_JSON_MAX_BYTES < 70_000);
  const env = await testEnv({ FEATURE_EVENTS_ENABLED: "true" });
  assert.equal(loadConfig(env, ISSUER).eventPublishRateLimit, 30);
  assert.equal(
    loadConfig({ ...env, EVENTS_PUBLISH_RATE_LIMIT: "7" }, ISSUER)
      .eventPublishRateLimit,
    7,
  );
  for (const invalid of ["0", "-1", "1.5", "none"]) {
    assert.throws(
      () => loadConfig({ ...env, EVENTS_PUBLISH_RATE_LIMIT: invalid }, ISSUER),
      /Expected positive integer/,
    );
  }
});

async function publicationFixture(
  options: {
    env?: Partial<RuntimeEnv>;
    clientScopes?: string[];
    tokenScope?: string;
  } = {},
): Promise<Fixture> {
  const env = await testEnv({
    FEATURE_EVENTS_ENABLED: "true",
    FEATURE_OAUTH_APPS_ENABLED: "true",
    ...options.env,
  });
  const config = loadConfig(env, ISSUER);
  const store = new MemoryAuthStore();
  const user = await store.findOrCreateUser(IDENTITY, nowSeconds());
  const client = await registerClient(
    store,
    "Events client",
    options.clientScopes ?? ["events.publish"],
  );
  const token = await humanToken(
    config,
    store,
    user,
    client,
    options.tokenScope ?? "events.publish",
  );
  return {
    env,
    config,
    store,
    app: createTestAittaDB(env, store, IDENTITY),
    user,
    client,
    token,
  };
}

async function registerClient(
  store: MemoryAuthStore,
  name: string,
  scopes = ["events.publish"],
): Promise<ClientView> {
  return (
    await createClientRegistration(
      {
        type: "public",
        name,
        redirectUris: [`${CLIENT_ORIGIN}/callback`],
        scopes,
        origins: [CLIENT_ORIGIN],
      },
      store,
      nowSeconds(),
      { eventsEnabled: true },
    )
  ).client;
}

async function humanToken(
  config: AppConfig,
  store: MemoryAuthStore,
  user: LocalUser,
  client: ClientView,
  scope: string,
): Promise<string> {
  const tokenSet = await issueTokens({
    config,
    store,
    user,
    client,
    scope,
    includeRefresh: false,
    now: nowSeconds(),
  });
  return String(tokenSet.access_token);
}

async function publish(
  fixture: Fixture,
  options: {
    token?: string | null;
    type?: string;
    data?: Record<string, unknown>;
    rawBody?: string;
    idempotencyKey?: string;
    origin?: string;
  } = {},
): Promise<Response> {
  const headers = new Headers({
    accept: HYPERMEDIA,
    "content-type": "application/json",
  });
  const token = options.token === undefined ? fixture.token : options.token;
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (options.idempotencyKey !== undefined) {
    headers.set("idempotency-key", options.idempotencyKey);
  }
  if (options.origin) headers.set("origin", options.origin);
  const response = await fixture.app.fetch(
    new Request(`${ISSUER}/events`, {
      method: "POST",
      headers,
      body:
        options.rawBody ??
        JSON.stringify({
          type: options.type ?? "orders.ready",
          data: options.data ?? { order: 42 },
        }),
    }),
  );
  assert.ok(response);
  return response;
}

async function eventCount(
  store: MemoryAuthStore,
  userId: string,
  clientId: string,
): Promise<number> {
  return (await store.listApplicationEvents(userId, clientId, null, 100)).items
    .length;
}

async function errorCode(response: Response): Promise<string> {
  return String(((await response.json()) as { error?: unknown }).error);
}

function browserRequest(
  values: Record<string, string>,
  cookieCsrf: string,
  origin: string,
  accept = HYPERMEDIA,
): Request {
  return new Request(`${ISSUER}/events`, {
    method: "POST",
    headers: {
      accept,
      "content-type": "application/x-www-form-urlencoded",
      cookie: `aittadb_csrf=${cookieCsrf}`,
      origin,
    },
    body: form(values),
  });
}

function observeStore(target: MemoryAuthStore): {
  store: AuthStore;
  calls: string[];
} {
  const calls: string[] = [];
  const store = new Proxy(target, {
    get(instance, property) {
      const value = Reflect.get(instance, property, instance) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return Reflect.apply(value, instance, args) as unknown;
      };
    },
  }) as AuthStore;
  return { store, calls };
}
