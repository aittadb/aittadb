import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_EVENT_CURSOR_TTL_SECONDS,
  encodeApplicationEventCursor,
} from "../../src/application-event-cursor";
import { issueBrowserSessionAccessToken } from "../../src/browser-session";
import { loadConfig } from "../../src/config";
import { nowSeconds, sha256, uuid } from "../../src/crypto";
import type { EventWaitScheduler } from "../../src/event-collection";
import type { HypermediaDocument } from "../../src/hypermedia";
import { createClientRegistration, issueTokens } from "../../src/oauth";
import { MemoryAuthStore } from "../../src/store/memory";
import { BROWSER_SESSION_CLIENT_ID } from "../../src/system-client";
import type {
  AppConfig,
  ApplicationEventInput,
  ClientView,
  LocalUser,
  RuntimeEnv,
  UpstreamIdentity,
} from "../../src/types";
import { createTestAittaDB, testEnv, testIdentityProvider } from "../helpers";

const ISSUER = "https://aittadb.example.test";
const HYPERMEDIA = "application/vnd.aittadb+json; version=0.1";
const CLIENT_ORIGIN = "https://events-client.example.test";
const IDENTITY: UpstreamIdentity = {
  email: "event-reader@example.test",
  fullName: "Event Reader",
  displayName: "Event Reader",
};

interface EventItemDocument {
  data: {
    id: string;
    type: string;
    data: Record<string, unknown>;
    created_at: number;
    expires_at: number;
  };
  links: Array<{ rel: string[]; href: string }>;
}

interface EventCollectionData {
  count: number;
  page_size: number;
  has_more: boolean;
  type_filter: string | null;
  resume_cursor: string;
  items: EventItemDocument[];
}

interface EventFixture {
  app: ReturnType<typeof createTestAittaDB>;
  config: AppConfig;
  store: MemoryAuthStore;
  user: LocalUser;
  otherUser: LocalUser;
  client: ClientView;
  otherClient: ClientView;
  accessToken: string;
  subscribeToken: string;
  otherClientToken: string;
  otherUserToken: string;
  missingScopeToken: string;
  ownedIds: string[];
  foreignMarkers: string[];
}

test("event collection returns bounded oldest-first pages and exact filtered resumes", async () => {
  const fixture = await eventFixture();
  const first = await bearerGet(
    fixture,
    `${ISSUER}/events?page_size=2`,
    fixture.accessToken,
  );
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.match(
    first.headers.get("content-type") ?? "",
    /^application\/vnd\.aittadb\+json/,
  );
  assert.equal(first.headers.get("aittadb-api-version"), "0.1");
  const firstDocument =
    (await first.json()) as HypermediaDocument<EventCollectionData>;
  assert.equal(firstDocument.type, "application-event-collection");
  assert.equal(firstDocument.data.count, 2);
  assert.equal(firstDocument.data.page_size, 2);
  assert.equal(firstDocument.data.has_more, true);
  assert.equal(firstDocument.data.type_filter, null);
  assert.equal("delivery" in firstDocument.data, false);
  assert.equal(
    firstDocument.actions.some((item) => item.name === "wait-for-events"),
    false,
  );
  assert.deepEqual(
    firstDocument.data.items.map((item) => item.data.id),
    fixture.ownedIds.slice(0, 2),
  );
  for (const item of firstDocument.data.items) {
    assert.ok(
      item.links.some(
        (candidate) =>
          candidate.rel.includes("self") &&
          candidate.href === `${ISSUER}/events/${item.data.id}`,
      ),
    );
  }
  assert.ok(firstDocument.data.resume_cursor.length > 20);
  const firstBody = JSON.stringify(firstDocument);
  for (const forbidden of [
    fixture.user.id,
    fixture.client.id,
    ...fixture.foreignMarkers,
    "requestHash",
    "idempotencyKeyHash",
    "sequence",
  ]) {
    assert.equal(firstBody.includes(forbidden), false, forbidden);
  }

  const next = firstDocument.links.find((item) => item.rel.includes("next"));
  assert.ok(next);
  const second = await bearerGet(fixture, next.href, fixture.accessToken);
  assert.equal(second.status, 200);
  const secondDocument =
    (await second.json()) as HypermediaDocument<EventCollectionData>;
  assert.deepEqual(
    secondDocument.data.items.map((item) => item.data.id),
    fixture.ownedIds.slice(2),
  );
  assert.equal(secondDocument.data.has_more, false);
  assert.equal(
    secondDocument.links.some((item) => item.rel.includes("next")),
    false,
  );
  assert.equal(
    secondDocument.links.some((item) => item.rel.includes("resume")),
    true,
  );

  const filtered = await bearerGet(
    fixture,
    `${ISSUER}/events?page_size=1&type=invoice.created`,
    fixture.accessToken,
  );
  assert.equal(filtered.status, 200);
  const filteredDocument =
    (await filtered.json()) as HypermediaDocument<EventCollectionData>;
  assert.equal(filteredDocument.data.type_filter, "invoice.created");
  assert.deepEqual(
    filteredDocument.data.items.map((item) => item.data.id),
    [fixture.ownedIds[0]],
  );
  const filteredNext = filteredDocument.links.find((item) =>
    item.rel.includes("next"),
  );
  assert.ok(filteredNext);
  assert.equal(
    new URL(filteredNext.href).searchParams.get("type"),
    "invoice.created",
  );
  const filteredSecond = await bearerGet(
    fixture,
    filteredNext.href,
    fixture.accessToken,
  );
  assert.equal(filteredSecond.status, 200);
  const filteredSecondDocument =
    (await filteredSecond.json()) as HypermediaDocument<EventCollectionData>;
  assert.deepEqual(
    filteredSecondDocument.data.items.map((item) => item.data.id),
    [fixture.ownedIds[2]],
  );

  const changedFilter = new URL(filteredNext.href);
  changedFilter.searchParams.set("type", "invoice.paid");
  await assertInvalidCursor(
    fixture,
    changedFilter.toString(),
    fixture.accessToken,
  );
  await assertInvalidCursor(fixture, next.href, fixture.otherClientToken);
  await assertInvalidCursor(fixture, next.href, fixture.otherUserToken);

  const expiredCursor = await encodeApplicationEventCursor(
    fixture.user.id,
    fixture.client.id,
    0,
    nowSeconds() - APPLICATION_EVENT_CURSOR_TTL_SECONDS - 1,
    fixture.config,
  );
  await assertInvalidCursor(
    fixture,
    `${ISSUER}/events?cursor=${encodeURIComponent(expiredCursor)}`,
    fixture.accessToken,
  );
  for (const query of [
    "cursor=malformed",
    "page_size=0",
    "page_size=01",
    "page_size=101",
    "type=bad%20type",
    "type=one&type=two",
    "wait=1",
    "wait=0",
    "wait=01",
    "wait=26",
    "unknown=value",
  ]) {
    const response = await bearerGet(
      fixture,
      `${ISSUER}/events?${query}`,
      fixture.accessToken,
    );
    assert.equal(response.status, 400, query);
  }
});

test("event collection enforces scope, active client and subject, and exact CORS", async () => {
  const fixture = await eventFixture();
  const missingScope = await bearerGet(
    fixture,
    `${ISSUER}/events`,
    fixture.missingScopeToken,
  );
  assert.equal(missingScope.status, 403);

  const foreignOrigin = await requiredResponse(
    fixture.app.fetch(
      new Request(`${ISSUER}/events`, {
        headers: {
          accept: HYPERMEDIA,
          authorization: `Bearer ${fixture.accessToken}`,
          origin: "https://foreign.example.test",
        },
      }),
    ),
  );
  assert.equal(foreignOrigin.status, 403);
  const allowedOrigin = await requiredResponse(
    fixture.app.fetch(
      new Request(`${ISSUER}/events`, {
        headers: {
          accept: HYPERMEDIA,
          authorization: `Bearer ${fixture.accessToken}`,
          origin: CLIENT_ORIGIN,
        },
      }),
    ),
  );
  assert.equal(allowedOrigin.status, 200);
  assert.equal(
    allowedOrigin.headers.get("access-control-allow-origin"),
    CLIENT_ORIGIN,
  );

  await fixture.store.setClientDisabled(fixture.client.id, nowSeconds());
  const disabled = await bearerGet(
    fixture,
    `${ISSUER}/events`,
    fixture.accessToken,
  );
  assert.equal(disabled.status, 401);
  await fixture.store.setClientDisabled(fixture.client.id, null);
  await fixture.store.startAccountDeletionJob(fixture.user.id, nowSeconds());
  const inactive = await bearerGet(
    fixture,
    `${ISSUER}/events`,
    fixture.accessToken,
  );
  assert.equal(inactive.status, 401);
  const body = `${await missingScope.text()}${await disabled.text()}${await inactive.text()}`;
  for (const marker of fixture.foreignMarkers) {
    assert.equal(body.includes(marker), false);
  }
});

test("event collection supports the real signed-in HTML and hypermedia session", async () => {
  const env = await eventEnv();
  const config = loadConfig(env, ISSUER);
  const store = new MemoryAuthStore();
  const user = await store.findOrCreateUser(IDENTITY, nowSeconds());
  const sessionToken = await issueBrowserSessionAccessToken(
    new Request(`${ISSUER}/events`),
    testIdentityProvider(IDENTITY),
    store,
    config,
    ["events.read"],
  );
  assert.equal(typeof sessionToken, "string");
  await appendEvent(
    store,
    config,
    user.id,
    BROWSER_SESSION_CLIENT_ID,
    "browser.created",
    "html-private-payload",
  );
  const app = createTestAittaDB(env, store, IDENTITY);

  const html = await requiredResponse(
    app.fetch(
      new Request(`${ISSUER}/events?page_size=1`, {
        headers: { accept: "text/html" },
      }),
    ),
  );
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("cache-control"), "no-store");
  const page = await html.text();
  assert.match(page, /Application events/);
  assert.match(page, /Wait for later events/);
  assert.match(page, /name="cursor" value="[^"]+"/);
  assert.match(page, /1 top-level field/);
  assert.match(
    page,
    /href="https:\/\/aittadb\.example\.test\/events\/[0-9a-f-]{36}"/,
  );
  assert.doesNotMatch(page, /html-private-payload/);
  assert.doesNotMatch(page, /access_token|authorization: bearer/i);

  const empty = await requiredResponse(
    app.fetch(
      new Request(`${ISSUER}/events?type=missing.type`, {
        headers: { accept: "text/html" },
      }),
    ),
  );
  assert.equal(empty.status, 200);
  assert.match(await empty.text(), /No events found for this exact type/);

  const json = await requiredResponse(
    app.fetch(
      new Request(`${ISSUER}/events`, { headers: { accept: HYPERMEDIA } }),
    ),
  );
  assert.equal(json.status, 200);
  const document =
    (await json.json()) as HypermediaDocument<EventCollectionData>;
  const action = document.actions.find((item) => item.name === "list-events");
  assert.equal(action?.authorization?.scheme, "sites-session");
  const waitAction = document.actions.find(
    (item) => item.name === "wait-for-events",
  );
  assert.deepEqual(waitAction?.authorization?.scopes, [
    "events.read",
    "events.subscribe",
  ]);

  const signedOutApp = createTestAittaDB(env, new MemoryAuthStore(), null);
  const signedOutJson = await requiredResponse(
    signedOutApp.fetch(
      new Request(`${ISSUER}/events`, { headers: { accept: HYPERMEDIA } }),
    ),
  );
  assert.equal(signedOutJson.status, 401);
  const signedOutDocument = (await signedOutJson.json()) as {
    actions: Array<{ name: string }>;
  };
  assert.equal(
    signedOutDocument.actions.some((item) => item.name === "begin-session"),
    true,
  );
  const signedOutHtml = await requiredResponse(
    signedOutApp.fetch(
      new Request(`${ISSUER}/events`, { headers: { accept: "text/html" } }),
    ),
  );
  assert.equal(signedOutHtml.status, 302);
  assert.equal(
    new URL(signedOutHtml.headers.get("location")!, ISSUER).pathname,
    "/signin-with-chatgpt",
  );
});

test("bounded event wait returns promptly only for a later event in the exact namespace", async () => {
  const scheduler = new DeterministicWaitScheduler();
  const fixture = await eventFixture(
    {
      EVENTS_MAX_WAIT_SECONDS: "4",
      EVENTS_MAX_WAIT_READS: "5",
    },
    scheduler,
  );
  const cursor = await latestCursor(fixture);
  let sleepCount = 0;
  scheduler.onSleep = async () => {
    sleepCount += 1;
    if (sleepCount === 1) {
      await appendEvent(
        fixture.store,
        fixture.config,
        fixture.user.id,
        fixture.otherClient.id,
        "private.client",
        "cross-namespace-later",
      );
    } else if (sleepCount === 2) {
      await appendEvent(
        fixture.store,
        fixture.config,
        fixture.user.id,
        fixture.client.id,
        "invoice.ready",
        "owned-later",
      );
    }
  };

  const response = await bearerGet(
    fixture,
    `${ISSUER}/events?cursor=${encodeURIComponent(cursor)}&page_size=10&wait=4`,
    fixture.subscribeToken,
  );
  assert.equal(response.status, 200);
  const document = (await response.json()) as HypermediaDocument<
    EventCollectionData & {
      delivery: { wait_seconds: number; timed_out: boolean };
    }
  >;
  assert.equal(document.data.delivery.wait_seconds, 4);
  assert.equal(document.data.delivery.timed_out, false);
  assert.equal(document.data.count, 1);
  assert.equal(document.data.items[0]?.data.type, "invoice.ready");
  assert.equal(
    JSON.stringify(document).includes("cross-namespace-later"),
    false,
  );
  assert.equal(scheduler.sleeps.length, 2);
  assert.deepEqual(scheduler.sleeps, [1000, 1000]);
});

test("bounded event wait has deterministic timeout and finite repository reads", async () => {
  const scheduler = new DeterministicWaitScheduler();
  const fixture = await eventFixture(
    {
      EVENTS_MAX_WAIT_SECONDS: "3",
      EVENTS_MAX_WAIT_READS: "4",
    },
    scheduler,
  );
  const cursor = await latestCursor(fixture);
  const originalList = fixture.store.listApplicationEvents.bind(fixture.store);
  let reads = 0;
  fixture.store.listApplicationEvents = async (...args) => {
    reads += 1;
    return originalList(...args);
  };

  const response = await bearerGet(
    fixture,
    `${ISSUER}/events?cursor=${encodeURIComponent(cursor)}&wait=3`,
    fixture.subscribeToken,
  );
  assert.equal(response.status, 200);
  const document = (await response.json()) as HypermediaDocument<
    EventCollectionData & {
      delivery: { wait_seconds: number; timed_out: boolean };
    }
  >;
  assert.equal(document.data.count, 0);
  assert.deepEqual(document.data.delivery, {
    wait_seconds: 3,
    timed_out: true,
  });
  assert.equal(reads, 4);
  assert.deepEqual(scheduler.sleeps, [1000, 1000, 1000]);
});

test("bounded event wait stops on cancellation without another repository read", async () => {
  const scheduler = new DeterministicWaitScheduler();
  const fixture = await eventFixture({}, scheduler);
  const cursor = await latestCursor(fixture);
  const controller = new AbortController();
  scheduler.onSleep = () => {
    controller.abort();
  };
  const originalList = fixture.store.listApplicationEvents.bind(fixture.store);
  let reads = 0;
  fixture.store.listApplicationEvents = async (...args) => {
    reads += 1;
    return originalList(...args);
  };
  const response = await requiredResponse(
    fixture.app.fetch(
      new Request(
        `${ISSUER}/events?cursor=${encodeURIComponent(cursor)}&wait=5`,
        {
          signal: controller.signal,
          headers: {
            accept: HYPERMEDIA,
            authorization: `Bearer ${fixture.subscribeToken}`,
          },
        },
      ),
    ),
  );
  assert.equal(response.status, 499);
  assert.equal(reads, 1);
  assert.equal(scheduler.sleeps.length, 1);
});

test("bounded event wait rejects invalid cursors, missing scope, disabled clients, and subscribe abuse before waiting", async () => {
  const scheduler = new DeterministicWaitScheduler();
  const fixture = await eventFixture(
    { EVENTS_SUBSCRIBE_RATE_LIMIT: "1" },
    scheduler,
  );
  const cursor = await latestCursor(fixture);

  const invalid = await bearerGet(
    fixture,
    `${ISSUER}/events?cursor=invalid&wait=1`,
    fixture.subscribeToken,
  );
  assert.equal(invalid.status, 400);
  const missingScope = await bearerGet(
    fixture,
    `${ISSUER}/events?cursor=${encodeURIComponent(cursor)}&wait=1`,
    fixture.accessToken,
  );
  assert.equal(missingScope.status, 403);
  assert.equal(scheduler.sleeps.length, 0);

  const first = await bearerGet(
    fixture,
    `${ISSUER}/events?cursor=${encodeURIComponent(cursor)}&wait=1`,
    fixture.subscribeToken,
  );
  assert.equal(first.status, 200);
  const sleepsAfterFirstWait = scheduler.sleeps.length;
  const limited = await bearerGet(
    fixture,
    `${ISSUER}/events?cursor=${encodeURIComponent(cursor)}&wait=1`,
    fixture.subscribeToken,
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(scheduler.sleeps.length, sleepsAfterFirstWait);

  await fixture.store.setClientDisabled(fixture.client.id, nowSeconds());
  const disabled = await bearerGet(
    fixture,
    `${ISSUER}/events?cursor=${encodeURIComponent(cursor)}&wait=1`,
    fixture.subscribeToken,
  );
  assert.equal(disabled.status, 401);
});

test("event collection feature gate and read rate limit fail before disclosure", async () => {
  const disabledEnv = await testEnv({ FEATURE_EVENTS_ENABLED: "false" });
  const disabledStore = new MemoryAuthStore();
  disabledStore.getClient = async () => {
    throw new Error("feature gate reached repository");
  };
  const disabledApp = createTestAittaDB(disabledEnv, disabledStore, null);
  const disabled = await requiredResponse(
    disabledApp.fetch(
      new Request(`${ISSUER}/events?wait=999`, {
        headers: { accept: HYPERMEDIA, authorization: "Bearer invalid" },
      }),
    ),
  );
  assert.equal(disabled.status, 503);
  assert.equal(disabledStore.counters.size, 0);

  const fixture = await eventFixture({ EVENTS_READ_RATE_LIMIT: "1" });
  assert.equal(
    (await bearerGet(fixture, `${ISSUER}/events`, fixture.accessToken)).status,
    200,
  );
  const limited = await bearerGet(
    fixture,
    `${ISSUER}/events`,
    fixture.accessToken,
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
});

async function eventFixture(
  extra: Partial<RuntimeEnv> = {},
  scheduler?: EventWaitScheduler,
): Promise<EventFixture> {
  const env = await eventEnv(extra);
  const config = loadConfig(env, ISSUER);
  const store = new MemoryAuthStore();
  const user = await store.findOrCreateUser(IDENTITY, nowSeconds());
  const otherUser = await store.findOrCreateUser(
    {
      email: "other-event-reader@example.test",
      fullName: "Other Event Reader",
      displayName: "Other Event Reader",
    },
    nowSeconds(),
  );
  const client = await registerClient(store, "Event reader", CLIENT_ORIGIN);
  const otherClient = await registerClient(
    store,
    "Other event reader",
    "https://other-events-client.example.test",
  );
  const ownedIds: string[] = [];
  for (const [type, marker] of [
    ["invoice.created", "owned-created-one"],
    ["invoice.paid", "owned-paid"],
    ["invoice.created", "owned-created-two"],
    ["invoice.shipped", "owned-shipped"],
  ] as const) {
    ownedIds.push(
      await appendEvent(store, config, user.id, client.id, type, marker),
    );
  }
  const foreignMarkers = ["other-client-secret", "other-user-secret"];
  await appendEvent(
    store,
    config,
    user.id,
    otherClient.id,
    "private.client",
    foreignMarkers[0],
  );
  await appendEvent(
    store,
    config,
    otherUser.id,
    client.id,
    "private.user",
    foreignMarkers[1],
  );

  return {
    app: createTestAittaDB(env, store, IDENTITY, scheduler),
    config,
    store,
    user,
    otherUser,
    client,
    otherClient,
    accessToken: await readToken(config, store, user, client, "events.read"),
    subscribeToken: await readToken(
      config,
      store,
      user,
      client,
      "events.read events.subscribe",
    ),
    otherClientToken: await readToken(
      config,
      store,
      user,
      otherClient,
      "events.read",
    ),
    otherUserToken: await readToken(
      config,
      store,
      otherUser,
      client,
      "events.read",
    ),
    missingScopeToken: await readToken(
      config,
      store,
      user,
      client,
      "storage.read",
    ),
    ownedIds,
    foreignMarkers,
  };
}

async function eventEnv(extra: Partial<RuntimeEnv> = {}): Promise<RuntimeEnv> {
  return testEnv({
    FEATURE_OAUTH_APPS_ENABLED: "true",
    FEATURE_EVENTS_ENABLED: "true",
    EVENTS_DEFAULT_PAGE_SIZE: "2",
    EVENTS_MAX_PAGE_SIZE: "100",
    EVENTS_READ_RATE_LIMIT: "1000",
    ...extra,
  });
}

async function registerClient(
  store: MemoryAuthStore,
  name: string,
  origin: string,
): Promise<ClientView> {
  return (
    await createClientRegistration(
      {
        type: "public",
        name,
        redirectUris: [`${origin}/callback`],
        scopes: ["events.read", "events.subscribe", "storage.read"],
        origins: [origin],
      },
      store,
      nowSeconds(),
      { eventsEnabled: true },
    )
  ).client;
}

async function readToken(
  config: AppConfig,
  store: MemoryAuthStore,
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
  type: string,
  marker: string,
): Promise<string> {
  const now = nowSeconds();
  const dataJson = JSON.stringify({ marker });
  const input: ApplicationEventInput = {
    id: uuid(),
    userId,
    clientId,
    type,
    dataJson,
    dataBytes: new TextEncoder().encode(dataJson).byteLength,
    idempotencyKeyHash: null,
    requestHash: await sha256(`${userId}:${clientId}:${type}:${marker}`),
    createdAt: now,
    expiresAt: now + 3600,
  };
  const result = await store.appendApplicationEvent(input, config.eventLimits);
  assert.equal(result.status, "created");
  return input.id;
}

function bearerGet(
  fixture: EventFixture,
  href: string,
  accessToken: string,
): Promise<Response> {
  return requiredResponse(
    fixture.app.fetch(
      new Request(href, {
        headers: {
          accept: HYPERMEDIA,
          authorization: `Bearer ${accessToken}`,
        },
      }),
    ),
  );
}

async function assertInvalidCursor(
  fixture: EventFixture,
  href: string,
  accessToken: string,
): Promise<void> {
  const response = await bearerGet(fixture, href, accessToken);
  assert.equal(response.status, 400);
  const body = await response.text();
  const document = JSON.parse(body) as { data: { error: string } };
  assert.equal(document.data.error, "invalid_request");
  for (const value of [
    fixture.user.id,
    fixture.client.id,
    ...fixture.foreignMarkers,
  ]) {
    assert.equal(body.includes(value), false);
  }
}

async function requiredResponse(
  response: Promise<Response | null>,
): Promise<Response> {
  const resolved = await response;
  assert.ok(resolved);
  return resolved;
}

async function latestCursor(fixture: EventFixture): Promise<string> {
  const response = await bearerGet(
    fixture,
    `${ISSUER}/events?page_size=100`,
    fixture.subscribeToken,
  );
  assert.equal(response.status, 200);
  const document =
    (await response.json()) as HypermediaDocument<EventCollectionData>;
  return document.data.resume_cursor;
}

class DeterministicWaitScheduler implements EventWaitScheduler {
  now = 0;
  readonly sleeps: number[] = [];
  onSleep: (() => void | Promise<void>) | null = null;

  nowMilliseconds(): number {
    return this.now;
  }

  async sleep(milliseconds: number, signal: AbortSignal): Promise<boolean> {
    this.sleeps.push(milliseconds);
    this.now += milliseconds;
    await this.onSleep?.();
    return !signal.aborted;
  }
}
