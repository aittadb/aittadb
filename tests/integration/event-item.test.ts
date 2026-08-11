import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { nowSeconds, sha256 } from "../../src/crypto";
import { createAittaDBWithStore } from "../../src/handler";
import {
  createClientRegistration,
  issueClientCredentialsToken,
  issueTokens,
} from "../../src/oauth";
import { MemoryAuthStore } from "../../src/store/memory";
import { BROWSER_SESSION_CLIENT_ID } from "../../src/system-client";
import type {
  AppConfig,
  ApplicationEvent,
  AuthStore,
  ClientType,
  ClientView,
  LocalUser,
  RuntimeEnv,
  UpstreamIdentity,
} from "../../src/types";
import { createTestAittaDB, testEnv } from "../helpers";

const ISSUER = "https://aittadb.example.test";
const HYPERMEDIA = "application/vnd.aittadb+json; version=0.1";
const EVENT_ID = "2f9b5ff8-2b4f-4f81-88e5-13d13f67778d";
const ABSENT_ID = "f57f61f0-3a27-4a12-a5dc-2d2e8f405f0f";
const OTHER_CLIENT_ID = "86da1125-c4f4-462a-9508-930507192f90";
const OTHER_USER_ID = "c697799d-9d91-4652-8cab-5e92c898d2cc";
const EXPIRED_ID = "15187f30-69b7-4f09-84df-2f66e0bd460c";
const EXTREME_TIME_ID = "29f7182f-364d-482f-a1ef-1b1ae79b21b6";
const IDENTITY: UpstreamIdentity = {
  email: "event-reader@example.test",
  fullName: "Event Reader",
  displayName: "Event Reader",
};

interface EventFixture {
  app: ReturnType<typeof createTestAittaDB>;
  config: AppConfig;
  env: RuntimeEnv;
  store: ObservedEventStore;
  user: LocalUser;
  client: ClientView;
  accessToken: string;
  event: ApplicationEvent;
}

class ObservedEventStore extends MemoryAuthStore {
  readonly eventLookups: Array<[string, string, string]> = [];
  readonly boundaryCalls: string[] = [];
  rejectRateLimits = false;

  override async getApplicationEvent(
    userId: string,
    clientId: string,
    id: string,
  ): Promise<ApplicationEvent | null> {
    this.eventLookups.push([userId, clientId, id]);
    this.boundaryCalls.push("getApplicationEvent");
    return super.getApplicationEvent(userId, clientId, id);
  }

  override async rateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
    now: number,
  ): Promise<boolean> {
    this.boundaryCalls.push("rateLimit");
    if (this.rejectRateLimits) return false;
    return super.rateLimit(key, limit, windowSeconds, now);
  }

  override async getClient(id: string): Promise<ClientView | null> {
    this.boundaryCalls.push("getClient");
    return super.getClient(id);
  }

  override async getUser(id: string): Promise<LocalUser | null> {
    this.boundaryCalls.push("getUser");
    return super.getUser(id);
  }

  override async getAccountDeletionJob(
    subject: string,
  ): ReturnType<MemoryAuthStore["getAccountDeletionJob"]> {
    this.boundaryCalls.push("getAccountDeletionJob");
    return super.getAccountDeletionJob(subject);
  }
}

test("bearer event read exposes only immutable public fields and navigation", async () => {
  const fixture = await eventFixture();
  const response = await eventRequest(fixture, EVENT_ID);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("aittadb-api-version"), "0.1");
  const document = (await response.json()) as {
    type: string;
    id: string;
    data: Record<string, unknown>;
    links: Array<{ rel: string[]; href: string }>;
    actions: unknown[];
  };
  assert.equal(document.type, "application-event");
  assert.equal(document.id, EVENT_ID);
  assert.deepEqual(document.data, {
    id: EVENT_ID,
    type: "example.created",
    data: { message: "hello", sequence: "public value" },
    created_at: fixture.event.createdAt,
    expires_at: fixture.event.expiresAt,
  });
  assert.deepEqual(document.actions, []);
  assert.ok(
    document.links.some(
      (candidate) =>
        candidate.rel.includes("self") &&
        candidate.href === `${ISSUER}/events/${EVENT_ID}`,
    ),
  );
  assert.ok(
    document.links.some(
      (candidate) =>
        candidate.rel.includes("collection") &&
        candidate.href === `${ISSUER}/events`,
    ),
  );
  const serialized = JSON.stringify(document);
  for (const privateField of [
    "userId",
    "clientId",
    "user_id",
    "client_id",
    "request_hash",
    "idempotency",
    '"sequence":1',
  ]) {
    assert.equal(serialized.includes(privateField), false, privateField);
  }
});

test("service bearer reads only its isolated non-human event namespace", async () => {
  const env = await testEnv({
    FEATURE_EVENTS_ENABLED: "true",
    FEATURE_OAUTH_APPS_ENABLED: "true",
  });
  const config = loadConfig(env, ISSUER);
  const store = new ObservedEventStore();
  const registration = await registerClient(store, "service", ["events.read"]);
  const event = await appendEvent(
    store,
    config,
    registration.client.id,
    registration.client.id,
    EVENT_ID,
  );
  const tokenResponse = await issueClientCredentialsToken({
    config,
    store,
    client: registration.client,
    requestedScope: "events.read",
    now: nowSeconds(),
  });
  const accessToken = String(
    ((await tokenResponse.json()) as { access_token: string }).access_token,
  );
  const app = createTestAittaDB(env, store, IDENTITY);
  const response = await requiredResponse(
    app.fetch(
      new Request(`${ISSUER}/events/${event.id}`, {
        headers: { accept: HYPERMEDIA, authorization: `Bearer ${accessToken}` },
      }),
    ),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(store.eventLookups.at(-1), [
    registration.client.id,
    registration.client.id,
    EVENT_ID,
  ]);
});

test("current Sites session renders equivalent hypermedia and accessible HTML", async () => {
  const env = await testEnv({ FEATURE_EVENTS_ENABLED: "true" });
  const config = loadConfig(env, ISSUER);
  const store = new ObservedEventStore();
  const user = await store.findOrCreateUser(IDENTITY, nowSeconds());
  const event = await appendEvent(
    store,
    config,
    user.id,
    BROWSER_SESSION_CLIENT_ID,
    EVENT_ID,
    { message: "<script>not markup</script>", count: 2 },
  );
  const app = createTestAittaDB(env, store, IDENTITY);

  const jsonResponse = await requiredResponse(
    app.fetch(
      new Request(`${ISSUER}/events/${EVENT_ID}`, {
        headers: { accept: HYPERMEDIA },
      }),
    ),
  );
  assert.equal(jsonResponse.status, 200);
  const document = (await jsonResponse.json()) as {
    data: { id: string; type: string; data: unknown };
    actions: unknown[];
  };
  assert.equal(document.data.id, event.id);
  assert.equal(document.data.type, event.type);
  assert.deepEqual(document.actions, []);
  assert.deepEqual(store.eventLookups.at(-1)?.slice(0, 2), [
    user.id,
    BROWSER_SESSION_CLIENT_ID,
  ]);

  const htmlResponse = await requiredResponse(
    app.fetch(
      new Request(`${ISSUER}/events/${EVENT_ID}`, {
        headers: { accept: "text/html" },
      }),
    ),
  );
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers.get("cache-control"), "no-store");
  assert.match(htmlResponse.headers.get("content-type") ?? "", /^text\/html/);
  const html = await htmlResponse.text();
  assert.match(html, /Event details/);
  assert.match(html, /example\.created/);
  assert.match(html, /&lt;script&gt;not markup&lt;\/script&gt;/);
  assert.match(html, /href="https:\/\/aittadb\.example\.test\/events"/);
  assert.match(html, /Back to events/);
  assert.doesNotMatch(html, /<form/i);
  assert.doesNotMatch(html, /Delete event|Update event|Replace event/i);
  assert.doesNotMatch(
    html,
    /Bearer |access_token|request_hash|client_id|user_id/i,
  );

  const anonymous = createTestAittaDB(env, store, null);
  const signIn = await requiredResponse(
    anonymous.fetch(
      new Request(`${ISSUER}/events/${EVENT_ID}`, {
        headers: { accept: "text/html" },
      }),
    ),
  );
  assert.equal(signIn.status, 302);
  const location = new URL(signIn.headers.get("location")!);
  assert.equal(location.pathname, "/signin-with-chatgpt");
  assert.equal(location.searchParams.get("return_to"), `/events/${EVENT_ID}`);
});

test("event HTML preserves a valid timestamp outside the ISO date range", async () => {
  const fixture = await eventFixture();
  const expiresAt = 8_640_000_000_001;
  await appendEvent(
    fixture.store,
    fixture.config,
    fixture.user.id,
    fixture.client.id,
    EXTREME_TIME_ID,
    { message: "far future" },
    expiresAt,
  );

  const response = await requiredResponse(
    fixture.app.fetch(
      new Request(`${ISSUER}/events/${EXTREME_TIME_ID}`, {
        headers: {
          accept: "text/html",
          authorization: `Bearer ${fixture.accessToken}`,
        },
      }),
    ),
  );

  assert.equal(response.status, 200);
  assert.match(await response.text(), /8640000000001 Unix seconds/);
});

test("current-session not-found HTML retains only generic collection recovery", async () => {
  const fixture = await eventFixture();
  const response = await requiredResponse(
    fixture.app.fetch(
      new Request(`${ISSUER}/events/${ABSENT_ID}`, {
        headers: { accept: "text/html" },
      }),
    ),
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  assert.match(html, /Event not found/);
  assert.match(html, /href="https:\/\/aittadb\.example\.test\/events"/);
  assert.match(html, /Back to events/);
  assert.doesNotMatch(html, /<form|Delete event|Update event|Replace event/i);
  assert.doesNotMatch(html, new RegExp(ABSENT_ID, "i"));
});

test("current Sites session rejects an inactive subject before event lookup", async () => {
  const env = await testEnv({ FEATURE_EVENTS_ENABLED: "true" });
  const store = new ObservedEventStore();
  const user = await store.findOrCreateUser(IDENTITY, nowSeconds());
  await store.startAccountDeletionJob(user.id, nowSeconds());
  store.boundaryCalls.length = 0;
  const app = createTestAittaDB(env, store, IDENTITY);

  const response = await requiredResponse(
    app.fetch(
      new Request(`${ISSUER}/events/${EVENT_ID}`, {
        headers: { accept: "text/html" },
      }),
    ),
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(store.eventLookups.length, 0);
  assert.doesNotMatch(await response.text(), new RegExp(EVENT_ID, "i"));
});

test("malformed, absent, expired, other-user, and other-client IDs are indistinguishable", async () => {
  const fixture = await eventFixture();
  const otherClient = await registerClient(fixture.store, "public", [
    "events.read",
  ]);
  await appendEvent(
    fixture.store,
    fixture.config,
    fixture.user.id,
    otherClient.client.id,
    OTHER_CLIENT_ID,
  );
  const otherUser = await fixture.store.findOrCreateUser(
    {
      email: "other-event-user@example.test",
      fullName: "Other Event User",
      displayName: "Other Event User",
    },
    nowSeconds(),
  );
  await appendEvent(
    fixture.store,
    fixture.config,
    otherUser.id,
    fixture.client.id,
    OTHER_USER_ID,
  );
  await appendEvent(
    fixture.store,
    fixture.config,
    fixture.user.id,
    fixture.client.id,
    EXPIRED_ID,
    { expired: true },
    nowSeconds() - 1,
  );

  const bodies: string[] = [];
  for (const id of [
    "not-a-canonical-uuid",
    EVENT_ID.toUpperCase(),
    "x".repeat(512),
    ABSENT_ID,
    EXPIRED_ID,
    OTHER_USER_ID,
    OTHER_CLIENT_ID,
  ]) {
    const response = await eventRequest(fixture, id);
    assert.equal(response.status, 404, id);
    assert.equal(response.headers.get("cache-control"), "no-store");
    bodies.push(await response.text());
  }
  assert.equal(new Set(bodies).size, 1);
  assert.equal(fixture.store.eventLookups.length, 4);
  assert.deepEqual(
    fixture.store.eventLookups.map((lookup) => lookup.slice(0, 2)),
    Array.from({ length: 4 }, () => [fixture.user.id, fixture.client.id]),
  );
});

test("scope, active client, active subject, and method checks precede event disclosure", async () => {
  const fixture = await eventFixture();
  const anonymous = createTestAittaDB(fixture.env, fixture.store, null);
  const missingToken = await requiredResponse(
    anonymous.fetch(
      new Request(`${ISSUER}/events/not-a-canonical-uuid`, {
        headers: { accept: HYPERMEDIA },
      }),
    ),
  );
  assert.equal(missingToken.status, 401);
  assert.equal(fixture.store.eventLookups.length, 0);

  const oversizedToken = await rawEventRequest(
    fixture,
    EVENT_ID,
    "x".repeat(16_385),
  );
  assert.equal(oversizedToken.status, 401);
  assert.equal(fixture.store.eventLookups.length, 0);

  const publishOnly = await registerClient(fixture.store, "public", [
    "events.publish",
  ]);
  const publishOnlyToken = await userAccessToken(
    fixture.config,
    fixture.store,
    fixture.user,
    publishOnly.client,
    "events.publish",
  );
  const missingScope = await rawEventRequest(
    fixture,
    EVENT_ID,
    publishOnlyToken,
  );
  assert.equal(missingScope.status, 403);
  assert.equal(
    ((await missingScope.json()) as { error: string }).error,
    "insufficient_scope",
  );
  assert.equal(fixture.store.eventLookups.length, 0);

  await fixture.store.setClientDisabled(fixture.client.id, nowSeconds());
  const disabledClient = await eventRequest(fixture, EVENT_ID);
  assert.equal(disabledClient.status, 401);
  assert.equal(fixture.store.eventLookups.length, 0);
  await fixture.store.setClientDisabled(fixture.client.id, null);

  await fixture.store.startAccountDeletionJob(fixture.user.id, nowSeconds());
  const inactive = await eventRequest(fixture, EVENT_ID);
  assert.equal(inactive.status, 401);
  assert.equal(fixture.store.eventLookups.length, 0);

  const post = await requiredResponse(
    fixture.app.fetch(
      new Request(`${ISSUER}/events/${EVENT_ID}`, {
        method: "POST",
        headers: {
          accept: HYPERMEDIA,
          authorization: `Bearer ${fixture.accessToken}`,
        },
      }),
    ),
  );
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
  assert.equal(fixture.store.eventLookups.length, 0);
});

test("unsupported event representation is rejected before route work", async () => {
  const fixture = await eventFixture();
  fixture.store.boundaryCalls.length = 0;

  const response = await requiredResponse(
    fixture.app.fetch(
      new Request(`${ISSUER}/events/${EVENT_ID}`, {
        headers: {
          accept: "application/xml",
          authorization: `Bearer ${fixture.accessToken}`,
        },
      }),
    ),
  );

  assert.equal(response.status, 406);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(fixture.store.boundaryCalls, []);
});

test("event item rate limiting stops the request before event lookup", async () => {
  const fixture = await eventFixture();
  fixture.store.rejectRateLimits = true;
  fixture.store.boundaryCalls.length = 0;

  const response = await eventRequest(fixture, EVENT_ID);

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "60");
  assert.deepEqual(fixture.store.boundaryCalls, ["rateLimit"]);
  assert.equal(fixture.store.eventLookups.length, 0);
});

test("event item CORS is bound to the active token audience client", async () => {
  const fixture = await eventFixture(["https://reader.example.test"]);
  const allowed = await eventRequest(fixture, EVENT_ID, {
    origin: "https://reader.example.test",
  });
  assert.equal(allowed.status, 200);
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    "https://reader.example.test",
  );
  const lookupsAfterAllowed = fixture.store.eventLookups.length;

  const rejected = await eventRequest(fixture, EVENT_ID, {
    origin: "https://foreign.example.test",
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  assert.equal(fixture.store.eventLookups.length, lookupsAfterAllowed);

  const preflight = await requiredResponse(
    fixture.app.fetch(
      new Request(`${ISSUER}/events/${EVENT_ID}`, {
        method: "OPTIONS",
        headers: {
          origin: "https://reader.example.test",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      }),
    ),
  );
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://reader.example.test",
  );
});

test("disabled Events rejects item requests before repository, identity, or rate work", async () => {
  const env = await testEnv({ FEATURE_EVENTS_ENABLED: "false" });
  const store = new ObservedEventStore();
  const scheduled: Promise<unknown>[] = [];
  let identityReads = 0;
  const app = createAittaDBWithStore(
    env,
    store,
    undefined,
    { waitUntil: (promise) => scheduled.push(promise) },
    {
      read: () => {
        identityReads += 1;
        return IDENTITY;
      },
    },
  );
  const response = await requiredResponse(
    app.fetch(
      new Request(`${ISSUER}/events/${EVENT_ID}`, {
        headers: {
          accept: HYPERMEDIA,
          origin: "https://foreign.example.test",
        },
      }),
    ),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    ((await response.json()) as { error: string }).error,
    "feature_unavailable",
  );
  assert.equal(identityReads, 0);
  assert.deepEqual(store.boundaryCalls, []);
  assert.deepEqual(scheduled, []);
});

async function eventFixture(origins: string[] = []): Promise<EventFixture> {
  const env = await testEnv({
    FEATURE_EVENTS_ENABLED: "true",
    FEATURE_OAUTH_APPS_ENABLED: "true",
  });
  const config = loadConfig(env, ISSUER);
  const store = new ObservedEventStore();
  const user = await store.findOrCreateUser(IDENTITY, nowSeconds());
  const registration = await registerClient(
    store,
    "public",
    ["events.read"],
    origins,
  );
  const accessToken = await userAccessToken(
    config,
    store,
    user,
    registration.client,
    "events.read",
  );
  const event = await appendEvent(
    store,
    config,
    user.id,
    registration.client.id,
    EVENT_ID,
  );
  store.boundaryCalls.length = 0;
  return {
    app: createTestAittaDB(env, store, IDENTITY),
    config,
    env,
    store,
    user,
    client: registration.client,
    accessToken,
    event,
  };
}

async function registerClient(
  store: MemoryAuthStore,
  type: ClientType,
  scopes: string[],
  origins: string[] = [],
) {
  return createClientRegistration(
    {
      type,
      name: `${type} event reader`,
      redirectUris:
        type === "service" ? [] : [`https://${type}.example.test/callback`],
      scopes,
      origins: type === "service" ? [] : origins,
    },
    store,
    nowSeconds(),
    { eventsEnabled: true },
  );
}

async function userAccessToken(
  config: AppConfig,
  store: AuthStore,
  user: LocalUser,
  client: ClientView,
  scope: string,
): Promise<string> {
  const tokens = await issueTokens({
    config,
    store,
    user,
    client,
    scope,
    includeRefresh: false,
    now: nowSeconds(),
  });
  return String(tokens.access_token);
}

async function appendEvent(
  store: MemoryAuthStore,
  config: AppConfig,
  userId: string,
  clientId: string,
  id: string,
  data: Record<string, unknown> = {
    message: "hello",
    sequence: "public value",
  },
  expiresAt = nowSeconds() + 3_600,
): Promise<ApplicationEvent> {
  const dataJson = JSON.stringify(data);
  const result = await store.appendApplicationEvent(
    {
      id,
      userId,
      clientId,
      type: "example.created",
      dataJson,
      dataBytes: new TextEncoder().encode(dataJson).byteLength,
      idempotencyKeyHash: null,
      requestHash: await sha256(`${id}:${dataJson}`),
      createdAt: Math.max(0, expiresAt - 3_600),
      expiresAt,
    },
    config.eventLimits,
  );
  assert.equal(result.status, "created");
  if (result.status !== "created") throw new Error("event fixture failed");
  return result.event;
}

function eventRequest(
  fixture: EventFixture,
  id: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return rawEventRequest(fixture, id, fixture.accessToken, extraHeaders);
}

function rawEventRequest(
  fixture: EventFixture,
  id: string,
  token: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return requiredResponse(
    fixture.app.fetch(
      new Request(`${ISSUER}/events/${id}`, {
        headers: {
          accept: HYPERMEDIA,
          authorization: `Bearer ${token}`,
          ...extraHeaders,
        },
      }),
    ),
  );
}

async function requiredResponse(
  response: Promise<Response | null>,
): Promise<Response> {
  const resolved = await response;
  assert.ok(resolved);
  return resolved;
}
