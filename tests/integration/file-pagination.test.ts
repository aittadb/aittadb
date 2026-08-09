import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { nowSeconds, sha256 } from "../../src/crypto";
import type { HypermediaDocument } from "../../src/hypermedia";
import { createClientRegistration, issueTokens } from "../../src/oauth";
import { MemoryAuthStore } from "../../src/store/memory";
import { BROWSER_SESSION_CLIENT_ID } from "../../src/system-client";
import type {
  AppConfig,
  ClientView,
  LocalUser,
  RuntimeEnv,
  StorageFileMetadata,
} from "../../src/types";
import { createTestAittaDB, MemoryR2Bucket, testEnv } from "../helpers";

const PAGE_SIZE = 19;
const FILE_COUNT = 211;

interface FileItemDocument {
  data: {
    key: string;
    content_type: string;
    size: number;
    sha256: string;
  };
}

interface FileCollectionData {
  count: number;
  page_size: number;
  has_more: boolean;
  items: FileItemDocument[];
}

interface ExpectedFile {
  body: Uint8Array;
  contentType: string;
  digest: string;
  metadata: StorageFileMetadata;
}

interface FilePaginationFixture {
  app: ReturnType<typeof createTestAittaDB>;
  bucket: MemoryR2Bucket;
  config: AppConfig;
  store: MemoryAuthStore;
  user: LocalUser;
  client: ClientView;
  accessToken: string;
  otherClientToken: string;
  otherUserToken: string;
  expected: Map<string, ExpectedFile>;
  otherClientKey: string;
  otherUserKey: string;
}

test("file hypermedia pagination follows bounded next links exactly once", async () => {
  const fixture = await filePaginationFixture();
  const visited = new Set<string>();
  const pageUrls = new Set<string>();
  let nextUrl: string | null =
    `${fixture.config.issuerUrl}/storage/files?page_size=${PAGE_SIZE}`;
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

    const body = await response.text();
    assertPrivateStateAbsent(body, fixture, new Set(fixture.expected.keys()));
    const document = JSON.parse(body) as HypermediaDocument<FileCollectionData>;
    assert.equal(document.type, "storage-files-collection");
    assert.equal(document.data.page_size, PAGE_SIZE);
    assert.equal(document.data.count, document.data.items.length);
    assert.ok(document.data.items.length <= PAGE_SIZE);
    assert.ok(document.data.items.length > 0);

    for (const item of document.data.items) {
      const key = item.data.key;
      const expected = fixture.expected.get(key);
      assert.ok(expected, `unexpected or cross-tenant file ${key}`);
      assert.equal(visited.has(key), false, `duplicate file ${key}`);
      assert.equal(item.data.content_type, expected.contentType);
      assert.equal(item.data.size, expected.body.byteLength);
      assert.equal(item.data.sha256, expected.digest);
      assert.equal("r2_key" in item.data, false);
      assert.equal("r2Key" in item.data, false);
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

  assert.equal(pageCount, Math.ceil(FILE_COUNT / PAGE_SIZE));
  assert.deepEqual([...visited].sort(), [...fixture.expected.keys()].sort());
  assert.ok(firstNextUrl);
  await assertFileStorageConsistent(fixture);

  await assertRejectedCursor(
    fixture,
    `${fixture.config.issuerUrl}/storage/files?cursor=malformed`,
    fixture.accessToken,
  );
  await assertRejectedCursor(fixture, firstNextUrl, fixture.otherClientToken);
  await assertRejectedCursor(fixture, firstNextUrl, fixture.otherUserToken);

  const oversized = await bearerGet(
    fixture,
    `${fixture.config.issuerUrl}/storage/files?page_size=${PAGE_SIZE + 1}`,
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

test("file HTML pagination renders and follows every bounded next-page control", async () => {
  const env = await paginationEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const bucket = env.BUCKET as MemoryR2Bucket;
  const store = new MemoryAuthStore();
  const user = await store.findOrCreateUser(
    {
      email: "user@example.test",
      fullName: "Pagination User",
      displayName: "Pagination User",
    },
    nowSeconds(),
  );
  const expected = await seedFiles(
    store,
    bucket,
    config,
    user.id,
    BROWSER_SESSION_CLIENT_ID,
    41,
    "browser-file",
  );
  const app = createTestAittaDB(env, store);
  const visited = new Set<string>();
  let nextUrl: string | null =
    `${config.issuerUrl}/storage/files?page_size=${PAGE_SIZE}`;
  let pageCount = 0;

  while (nextUrl) {
    const response = await app.fetch(
      new Request(nextUrl, { headers: { accept: "text/html" } }),
    );
    assert.ok(response);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    const page = await response.text();
    for (const file of expected.values()) {
      assert.equal(page.includes(file.metadata.r2Key), false);
    }
    const keys = [
      ...page.matchAll(/href="\/storage\/files\/([^"]+)">Open file<\/a>/g),
    ].map((match) => decodeURIComponent(match[1]!));
    assert.ok(keys.length <= PAGE_SIZE);
    assert.ok(keys.length > 0);
    for (const key of keys) {
      assert.ok(expected.has(key), `unexpected HTML file ${key}`);
      assert.equal(visited.has(key), false, `duplicate HTML file ${key}`);
      visited.add(key);
    }
    const nextMatch = page.match(/href="([^"]+)">Next page<\/a>/);
    nextUrl = nextMatch ? decodeHtmlAttribute(nextMatch[1]!) : null;
    pageCount += 1;
  }

  assert.equal(pageCount, Math.ceil(expected.size / PAGE_SIZE));
  assert.deepEqual([...visited].sort(), [...expected.keys()].sort());
  await assertSeededFilesConsistent(store, bucket, expected);
});

async function filePaginationFixture(): Promise<FilePaginationFixture> {
  const env = await paginationEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const bucket = env.BUCKET as MemoryR2Bucket;
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
  const expected = await seedFiles(
    store,
    bucket,
    config,
    user.id,
    client.id,
    FILE_COUNT,
    "file",
  );
  const otherClientKey = "other-client-private-file";
  const otherUserKey = "other-user-private-file";
  await seedFile(
    store,
    bucket,
    config,
    user.id,
    otherClient.id,
    otherClientKey,
    1,
  );
  await seedFile(
    store,
    bucket,
    config,
    otherUser.id,
    client.id,
    otherUserKey,
    1,
  );

  return {
    app: createTestAittaDB(env, store),
    bucket,
    config,
    store,
    user,
    client,
    accessToken: await readToken(config, store, user, client),
    otherClientToken: await readToken(config, store, user, otherClient),
    otherUserToken: await readToken(config, store, otherUser, client),
    expected,
    otherClientKey,
    otherUserKey,
  };
}

async function paginationEnv(): Promise<RuntimeEnv> {
  return testEnv({
    STORAGE_DEFAULT_PAGE_SIZE: "13",
    STORAGE_MAX_PAGE_SIZE: String(PAGE_SIZE),
    STORAGE_READ_RATE_LIMIT: "1000",
    STORAGE_GLOBAL_MAX_ITEMS: "2000",
    STORAGE_USER_MAX_ITEMS: "1000",
    STORAGE_NAMESPACE_MAX_ITEMS: "1000",
  });
}

async function seedFiles(
  store: MemoryAuthStore,
  bucket: MemoryR2Bucket,
  config: AppConfig,
  userId: string,
  clientId: string,
  count: number,
  prefix: string,
): Promise<Map<string, ExpectedFile>> {
  const files = new Map<string, ExpectedFile>();
  for (let index = 0; index < count; index += 1) {
    const key = `${prefix}-${String(index).padStart(4, "0")}.txt`;
    files.set(
      key,
      await seedFile(store, bucket, config, userId, clientId, key, index),
    );
  }
  return files;
}

async function seedFile(
  store: MemoryAuthStore,
  bucket: MemoryR2Bucket,
  config: AppConfig,
  userId: string,
  clientId: string,
  key: string,
  index: number,
): Promise<ExpectedFile> {
  const body = new TextEncoder().encode(`AittaDB fixture ${key} ${index}`);
  const contentType = index % 2 === 0 ? "text/plain" : "application/test";
  const digest = await sha256(body);
  const r2Key = `private/${userId}/${clientId}/${String(index).padStart(4, "0")}`;
  await bucket.put(r2Key, body, { httpMetadata: { contentType } });
  const metadata: StorageFileMetadata = {
    userId,
    clientId,
    key,
    r2Key,
    contentType,
    size: body.byteLength,
    sha256: digest,
    createdAt: 2_000 + Math.floor(index / 5),
    updatedAt: 2_000 + Math.floor(index / 5),
  };
  assert.equal(
    await store.upsertStorageFileMetadata(metadata, null, config.storageLimits),
    true,
  );
  return { body, contentType, digest, metadata };
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
  fixture: FilePaginationFixture,
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
  fixture: FilePaginationFixture,
  href: string,
  accessToken: string,
): Promise<void> {
  const response = await bearerGet(fixture, href, accessToken);
  assert.equal(response.status, 400);
  const body = await response.text();
  const document = JSON.parse(body) as { data: { error: string } };
  assert.equal(document.data.error, "invalid_request");
  assertPrivateStateAbsent(body, fixture);
}

async function assertNamespaceContainsOnly(
  fixture: FilePaginationFixture,
  accessToken: string,
  expectedKey: string,
): Promise<void> {
  const response = await bearerGet(
    fixture,
    `${fixture.config.issuerUrl}/storage/files?page_size=${PAGE_SIZE}`,
    accessToken,
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assertPrivateStateAbsent(body, fixture, new Set([expectedKey]));
  const document = JSON.parse(body) as HypermediaDocument<FileCollectionData>;
  assert.deepEqual(
    document.data.items.map((item) => item.data.key),
    [expectedKey],
  );
  assert.equal(document.data.has_more, false);
}

async function assertFileStorageConsistent(
  fixture: FilePaginationFixture,
): Promise<void> {
  await assertSeededFilesConsistent(
    fixture.store,
    fixture.bucket,
    fixture.expected,
  );
  assert.equal(fixture.bucket.objects.size, FILE_COUNT + 2);
}

async function assertSeededFilesConsistent(
  store: MemoryAuthStore,
  bucket: MemoryR2Bucket,
  expected: ReadonlyMap<string, ExpectedFile>,
): Promise<void> {
  for (const [key, file] of expected) {
    const metadata = await store.getStorageFileMetadata(
      file.metadata.userId,
      file.metadata.clientId,
      key,
    );
    assert.deepEqual(metadata, file.metadata);
    const object = await bucket.get(file.metadata.r2Key);
    assert.ok(object, `missing R2 bytes for ${key}`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    assert.deepEqual(bytes, file.body);
    assert.equal(await sha256(bytes), file.digest);
    assert.equal(object.httpMetadata?.contentType, file.contentType);
  }
}

function assertPrivateStateAbsent(
  body: string,
  fixture: FilePaginationFixture,
  allowedLogicalKeys: ReadonlySet<string> = new Set(),
): void {
  for (const secret of [
    fixture.user.id,
    fixture.client.id,
    fixture.otherClientKey,
    fixture.otherUserKey,
    ...fixture.expected.keys(),
    ...[...fixture.expected.values()].map((file) => file.metadata.r2Key),
  ]) {
    if (allowedLogicalKeys.has(secret)) continue;
    assert.equal(body.includes(secret), false, `response disclosed ${secret}`);
  }
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
