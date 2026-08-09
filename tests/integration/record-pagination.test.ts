import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { nowSeconds } from "../../src/crypto";
import type { HypermediaDocument } from "../../src/hypermedia";
import { createClientRegistration, issueTokens } from "../../src/oauth";
import { MemoryAuthStore } from "../../src/store/memory";
import { BROWSER_SESSION_CLIENT_ID } from "../../src/system-client";
import type {
  AppConfig,
  ClientView,
  LocalUser,
  RuntimeEnv,
  StorageRecord,
} from "../../src/types";
import { createTestAittaDB, testEnv } from "../helpers";

const PAGE_SIZE = 17;
const RECORD_COUNT = 237;

interface RecordItemDocument {
  data: { key: string; value: unknown };
}

interface RecordCollectionData {
  count: number;
  page_size: number;
  has_more: boolean;
  items: RecordItemDocument[];
}

interface RecordPaginationFixture {
  app: ReturnType<typeof createTestAittaDB>;
  config: AppConfig;
  store: MemoryAuthStore;
  user: LocalUser;
  client: ClientView;
  accessToken: string;
  otherClientToken: string;
  otherUserToken: string;
  expectedKeys: string[];
  otherClientKey: string;
  otherUserKey: string;
}

test("record hypermedia pagination follows bounded next links exactly once", async () => {
  const fixture = await recordPaginationFixture();
  const visited = new Set<string>();
  const pageUrls = new Set<string>();
  let nextUrl: string | null =
    `${fixture.config.issuerUrl}/storage/records?page_size=${PAGE_SIZE}`;
  let firstNextUrl: string | null = null;
  let pageCount = 0;

  while (nextUrl) {
    assert.equal(pageUrls.has(nextUrl), false, "next links must not cycle");
    pageUrls.add(nextUrl);
    const response = await bearerGet(fixture, nextUrl, fixture.accessToken);
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^application\/vnd\.aittadb\+json; version=0\.1/,
    );
    assert.equal(response.headers.get("aittadb-api-version"), "0.1");

    const document =
      (await response.json()) as HypermediaDocument<RecordCollectionData>;
    assert.equal(document.type, "storage-records-collection");
    assert.equal(document.data.page_size, PAGE_SIZE);
    assert.equal(document.data.count, document.data.items.length);
    assert.ok(document.data.items.length <= PAGE_SIZE);
    assert.ok(document.data.items.length > 0);

    for (const item of document.data.items) {
      const key = item.data.key;
      assert.equal(visited.has(key), false, `duplicate record ${key}`);
      assert.equal(key, String((item.data.value as { key: string }).key));
      assert.notEqual(key, fixture.otherClientKey);
      assert.notEqual(key, fixture.otherUserKey);
      visited.add(key);
    }

    const nextLinks = document.links.filter((link) =>
      link.rel.includes("next"),
    );
    assert.equal(nextLinks.length, document.data.has_more ? 1 : 0);
    const returnedNext = nextLinks[0]?.href ?? null;
    if (pageCount === 0) firstNextUrl = returnedNext;
    nextUrl = returnedNext;
    pageCount += 1;
  }

  assert.equal(pageCount, Math.ceil(RECORD_COUNT / PAGE_SIZE));
  assert.deepEqual([...visited].sort(), fixture.expectedKeys);
  assert.ok(firstNextUrl);

  await assertRejectedCursor(
    fixture,
    `${fixture.config.issuerUrl}/storage/records?cursor=malformed`,
    fixture.accessToken,
  );
  await assertRejectedCursor(fixture, firstNextUrl, fixture.otherClientToken);
  await assertRejectedCursor(fixture, firstNextUrl, fixture.otherUserToken);

  const oversized = await bearerGet(
    fixture,
    `${fixture.config.issuerUrl}/storage/records?page_size=${PAGE_SIZE + 1}`,
    fixture.accessToken,
  );
  assert.equal(oversized.status, 400);
  assert.equal(
    ((await oversized.json()) as { data: { error: string } }).data.error,
    "invalid_request",
  );

  await assertNamespaceContainsOnly(
    fixture,
    fixture.otherClientToken,
    fixture.otherClientKey,
  );
  await assertNamespaceContainsOnly(
    fixture,
    fixture.otherUserToken,
    fixture.otherUserKey,
  );
});

test("record HTML pagination renders and follows every bounded next-page control", async () => {
  const env = await paginationEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const user = await store.findOrCreateUser(
    {
      email: "user@example.test",
      fullName: "Pagination User",
      displayName: "Pagination User",
    },
    nowSeconds(),
  );
  const expectedKeys = await seedRecords(
    store,
    config,
    user.id,
    BROWSER_SESSION_CLIENT_ID,
    41,
    "browser-record",
  );
  const app = createTestAittaDB(env, store);
  const visited = new Set<string>();
  let nextUrl: string | null =
    `${config.issuerUrl}/storage/records?page_size=${PAGE_SIZE}`;
  let pageCount = 0;

  while (nextUrl) {
    const response = await app.fetch(
      new Request(nextUrl, { headers: { accept: "text/html" } }),
    );
    assert.ok(response);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    const page = await response.text();
    const keys = [
      ...page.matchAll(/href="\/storage\/records\/([^"]+)">Open record<\/a>/g),
    ].map((match) => decodeURIComponent(match[1]!));
    assert.ok(keys.length <= PAGE_SIZE);
    assert.ok(keys.length > 0);
    for (const key of keys) {
      assert.equal(visited.has(key), false, `duplicate HTML record ${key}`);
      visited.add(key);
    }
    const nextMatch = page.match(/href="([^"]+)">Next page<\/a>/);
    nextUrl = nextMatch ? decodeHtmlAttribute(nextMatch[1]!) : null;
    pageCount += 1;
  }

  assert.equal(pageCount, Math.ceil(expectedKeys.length / PAGE_SIZE));
  assert.deepEqual([...visited].sort(), expectedKeys);
});

async function recordPaginationFixture(): Promise<RecordPaginationFixture> {
  const env = await paginationEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const user = await store.findOrCreateUser(
    {
      email: "pagination@example.test",
      fullName: "Pagination User",
      displayName: "Pagination User",
    },
    nowSeconds(),
  );
  const client = (
    await createClientRegistration(
      {
        type: "public",
        name: "Pagination Client",
        redirectUris: ["https://pagination.example.test/callback"],
        scopes: ["storage.read"],
        origins: [],
      },
      store,
      nowSeconds(),
    )
  ).client;
  const otherClient = (
    await createClientRegistration(
      {
        type: "public",
        name: "Other Pagination Client",
        redirectUris: ["https://other.example.test/callback"],
        scopes: ["storage.read"],
        origins: [],
      },
      store,
      nowSeconds(),
    )
  ).client;
  const otherUser = await store.findOrCreateUser(
    {
      email: "other-pagination@example.test",
      fullName: "Other Pagination User",
      displayName: "Other Pagination User",
    },
    nowSeconds(),
  );
  const expectedKeys = await seedRecords(
    store,
    config,
    user.id,
    client.id,
    RECORD_COUNT,
    "record",
  );
  const otherClientKey = "other-client-private-record";
  const otherUserKey = "other-user-private-record";
  await seedRecord(store, config, user.id, otherClient.id, otherClientKey, 1);
  await seedRecord(store, config, otherUser.id, client.id, otherUserKey, 1);

  return {
    app: createTestAittaDB(env, store),
    config,
    store,
    user,
    client,
    accessToken: await readToken(config, store, user, client),
    otherClientToken: await readToken(config, store, user, otherClient),
    otherUserToken: await readToken(config, store, otherUser, client),
    expectedKeys,
    otherClientKey,
    otherUserKey,
  };
}

async function paginationEnv(): Promise<RuntimeEnv> {
  return testEnv({
    STORAGE_DEFAULT_PAGE_SIZE: "11",
    STORAGE_MAX_PAGE_SIZE: String(PAGE_SIZE),
    STORAGE_READ_RATE_LIMIT: "1000",
    STORAGE_GLOBAL_MAX_ITEMS: "2000",
    STORAGE_USER_MAX_ITEMS: "1000",
    STORAGE_NAMESPACE_MAX_ITEMS: "1000",
  });
}

async function seedRecords(
  store: MemoryAuthStore,
  config: AppConfig,
  userId: string,
  clientId: string,
  count: number,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const key = `${prefix}-${String(index).padStart(4, "0")}`;
    await seedRecord(store, config, userId, clientId, key, index);
    keys.push(key);
  }
  return keys.sort();
}

async function seedRecord(
  store: MemoryAuthStore,
  config: AppConfig,
  userId: string,
  clientId: string,
  key: string,
  index: number,
): Promise<void> {
  const record: StorageRecord = {
    userId,
    clientId,
    key,
    valueJson: JSON.stringify({ key, index }),
    createdAt: 1_000 + Math.floor(index / 7),
    updatedAt: 1_000 + Math.floor(index / 7),
  };
  assert.equal(
    await store.upsertStorageRecord(record, config.storageLimits),
    true,
  );
}

async function readToken(
  config: AppConfig,
  store: MemoryAuthStore,
  user: LocalUser,
  client: ClientView,
): Promise<string> {
  const tokens = await issueTokens({
    config,
    store,
    user,
    client,
    scope: "storage.read",
    includeRefresh: false,
    now: nowSeconds(),
  });
  return String(tokens.access_token);
}

function bearerGet(
  fixture: RecordPaginationFixture,
  href: string,
  accessToken: string,
): Promise<Response> {
  return requiredResponse(
    fixture.app.fetch(
      new Request(href, {
        headers: {
          accept: "application/vnd.aittadb+json; version=0.1",
          authorization: `Bearer ${accessToken}`,
        },
      }),
    ),
  );
}

async function assertRejectedCursor(
  fixture: RecordPaginationFixture,
  href: string,
  accessToken: string,
): Promise<void> {
  const response = await bearerGet(fixture, href, accessToken);
  assert.equal(response.status, 400);
  const body = await response.text();
  const document = JSON.parse(body) as { data: { error: string } };
  assert.equal(document.data.error, "invalid_request");
  for (const secret of [
    fixture.user.id,
    fixture.client.id,
    fixture.expectedKeys[0]!,
    fixture.otherClientKey,
    fixture.otherUserKey,
  ]) {
    assert.equal(body.includes(secret), false);
  }
}

async function assertNamespaceContainsOnly(
  fixture: RecordPaginationFixture,
  accessToken: string,
  expectedKey: string,
): Promise<void> {
  const response = await bearerGet(
    fixture,
    `${fixture.config.issuerUrl}/storage/records?page_size=${PAGE_SIZE}`,
    accessToken,
  );
  assert.equal(response.status, 200);
  const document =
    (await response.json()) as HypermediaDocument<RecordCollectionData>;
  assert.deepEqual(
    document.data.items.map((item) => item.data.key),
    [expectedKey],
  );
  assert.equal(document.data.has_more, false);
}

function decodeHtmlAttribute(value: string): string {
  return value.replaceAll("&amp;", "&");
}

async function requiredResponse(
  response: Promise<Response | null>,
): Promise<Response> {
  const resolved = await response;
  assert.ok(resolved);
  return resolved;
}
