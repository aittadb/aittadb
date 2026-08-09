import assert from "node:assert/strict";
import test from "node:test";

import { issueBrowserSessionAccessToken } from "../../src/browser-session";
import { loadConfig } from "../../src/config";
import { nowSeconds, sha256 } from "../../src/crypto";
import { MemoryAuthStore } from "../../src/store/memory";
import { BROWSER_SESSION_CLIENT_ID } from "../../src/system-client";
import type {
  AppConfig,
  LocalUser,
  RuntimeEnv,
  StorageFileMetadata,
  UpstreamIdentity,
} from "../../src/types";
import {
  cookieValue,
  createTestAittaDB,
  form,
  MemoryR2Bucket,
  testEnv,
  testIdentityProvider,
} from "../helpers";

const VENDOR = "application/vnd.aittadb+json; version=0.1";
const IDENTITY: UpstreamIdentity = {
  email: "write-switch@example.test",
  fullName: "Write Switch",
  displayName: "Write Switch",
};
const RECORD_KEY = "existing-record";
const FILE_KEY = "existing-file.txt";

interface HypermediaActionValue {
  name: string;
}

interface HypermediaDocumentValue {
  actions: HypermediaActionValue[];
  data?: {
    items?: HypermediaDocumentValue[];
  };
}

interface KillSwitchFixture {
  app: ReturnType<typeof createTestAittaDB>;
  bucket: MemoryR2Bucket;
  config: AppConfig;
  env: RuntimeEnv;
  store: MemoryAuthStore;
  token: string;
  user: LocalUser;
  file: StorageFileMetadata;
}

test("disabled writes disappear from signed-in storage hypermedia", async () => {
  const fixture = await killSwitchFixture();

  const records = await sessionDocument(fixture, "/storage/records", 200);
  assertActions(
    records,
    ["list-records", "open-record"],
    ["create-or-replace-record"],
  );
  assertActions(
    records.data?.items?.[0],
    ["read-record", "delete-record"],
    ["replace-record"],
  );

  const record = await sessionDocument(
    fixture,
    `/storage/records/${RECORD_KEY}`,
    200,
  );
  assertActions(
    record,
    ["read-record", "delete-record"],
    ["create-record", "replace-record", "create-or-replace-record"],
  );
  const missingRecord = await sessionDocument(
    fixture,
    "/storage/records/missing-record",
    404,
  );
  assertActions(missingRecord, [], ["create-record"]);

  const files = await sessionDocument(fixture, "/storage/files", 200);
  assertActions(
    files,
    ["list-files", "open-file"],
    ["create-file", "create-or-replace-file"],
  );
  assertActions(
    files.data?.items?.[0],
    ["read-file", "download-file", "delete-file"],
    ["replace-file"],
  );

  const file = await sessionDocument(
    fixture,
    `/storage/files/${FILE_KEY}`,
    200,
  );
  assertActions(
    file,
    ["read-file", "download-file", "delete-file"],
    ["create-file", "replace-file", "create-or-replace-file"],
  );
  const missingFile = await sessionDocument(
    fixture,
    "/storage/files/missing-file.txt",
    404,
  );
  assertActions(missingFile, [], ["create-file"]);
});

test("disabled writes disappear from signed-in and signed-out storage HTML", async () => {
  const fixture = await killSwitchFixture();

  const signedInCases = [
    {
      path: "/storage/records",
      status: 200,
      present: ["List records", "Open one record"],
    },
    {
      path: `/storage/records/${RECORD_KEY}`,
      status: 200,
      present: ["Read record", "Delete record"],
    },
    {
      path: "/storage/records/missing-record",
      status: 404,
      present: ["Storage request failed"],
    },
    {
      path: "/storage/files",
      status: 200,
      present: ["List files", "Open one file"],
    },
    {
      path: `/storage/files/${FILE_KEY}`,
      status: 200,
      present: ["Download file", "Delete file"],
    },
    {
      path: "/storage/files/missing-file.txt",
      status: 404,
      present: ["Storage request failed"],
    },
  ] as const;

  for (const current of signedInCases) {
    const response = await requiredResponse(
      fixture.app.fetch(
        new Request(new URL(current.path, fixture.config.issuerUrl), {
          headers: { accept: "text/html" },
        }),
      ),
    );
    assert.equal(response.status, current.status, current.path);
    const page = await response.text();
    for (const text of current.present) assert.match(page, new RegExp(text));
    assertNoWriteControls(page);
  }

  const signedOut = createTestAittaDB(fixture.env, fixture.store, null);
  for (const current of [
    {
      path: "/storage/records",
      present: ["List records", "Open one record"],
    },
    {
      path: "/storage/records/unresolved-record",
      present: ["Read record", "Delete record"],
    },
    {
      path: "/storage/files",
      present: ["List files", "Open one file"],
    },
    {
      path: "/storage/files/unresolved-file.txt",
      present: ["Download file", "Delete file"],
    },
  ] as const) {
    const response = await requiredResponse(
      signedOut.fetch(
        new Request(new URL(current.path, fixture.config.issuerUrl), {
          headers: { accept: "text/html" },
        }),
      ),
    );
    assert.equal(response.status, 200, current.path);
    const page = await response.text();
    for (const text of current.present) assert.match(page, new RegExp(text));
    assertNoWriteControls(page);
  }
});

test("canonical and browser writes return non-persisting 503 while reads and deletes remain", async () => {
  const fixture = await killSwitchFixture();
  const originalRecord = await fixture.store.getStorageRecord(
    fixture.user.id,
    BROWSER_SESSION_CLIENT_ID,
    RECORD_KEY,
  );
  assert.ok(originalRecord);

  for (const request of [
    canonicalRequest(fixture, "/storage/records/new-record", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blocked: true }),
    }),
    canonicalRequest(fixture, `/storage/records/${RECORD_KEY}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replaced: true }),
    }),
    canonicalRequest(fixture, "/storage/files", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "blocked generated upload",
    }),
    canonicalRequest(fixture, "/storage/files/new-file.txt", {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "blocked named upload",
    }),
    canonicalRequest(fixture, `/storage/files/${FILE_KEY}`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "blocked replacement",
    }),
  ]) {
    await assertDisabledJson(await request);
  }

  const entry = await requiredResponse(
    fixture.app.fetch(
      new Request(`${fixture.config.issuerUrl}/storage/records`, {
        headers: { accept: "text/html" },
      }),
    ),
  );
  const csrf = cookieValue(entry, "aittadb_csrf");
  const browserHeaders = {
    accept: "text/html",
    cookie: `aittadb_csrf=${csrf}`,
    origin: fixture.config.issuerUrl,
  };

  for (const path of [
    "/storage/records/new-browser-record",
    `/storage/records/${RECORD_KEY}`,
  ]) {
    const response = await requiredResponse(
      fixture.app.fetch(
        new Request(new URL(path, fixture.config.issuerUrl), {
          method: "POST",
          headers: {
            ...browserHeaders,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form({
            ui: "1",
            csrf_token: csrf,
            auth_mode: "session",
            _method: "PUT",
            value: JSON.stringify({ blocked: true }),
          }),
        }),
      ),
    );
    await assertDisabledHtml(response);
  }

  for (const current of [
    { path: "/storage/files", method: "POST" },
    { path: `/storage/files/${FILE_KEY}`, method: "PUT" },
  ] as const) {
    const upload = new FormData();
    upload.set("ui", "1");
    upload.set("csrf_token", csrf);
    upload.set("auth_mode", "session");
    upload.set("_method", current.method);
    upload.set(
      "file",
      new File(["blocked browser upload"], "blocked.txt", {
        type: "text/plain",
      }),
    );
    const response = await requiredResponse(
      fixture.app.fetch(
        new Request(new URL(current.path, fixture.config.issuerUrl), {
          method: "POST",
          headers: browserHeaders,
          body: upload,
        }),
      ),
    );
    await assertDisabledHtml(response);
  }

  assert.equal(
    await fixture.store.getStorageRecord(
      fixture.user.id,
      BROWSER_SESSION_CLIENT_ID,
      "new-record",
    ),
    null,
  );
  assert.equal(
    await fixture.store.getStorageRecord(
      fixture.user.id,
      BROWSER_SESSION_CLIENT_ID,
      "new-browser-record",
    ),
    null,
  );
  assert.equal(
    (
      await fixture.store.getStorageRecord(
        fixture.user.id,
        BROWSER_SESSION_CLIENT_ID,
        RECORD_KEY,
      )
    )?.valueJson,
    originalRecord.valueJson,
  );
  assert.equal(
    await fixture.store.getStorageFileMetadata(
      fixture.user.id,
      BROWSER_SESSION_CLIENT_ID,
      "new-file.txt",
    ),
    null,
  );
  const storedFile = await fixture.store.getStorageFileMetadata(
    fixture.user.id,
    BROWSER_SESSION_CLIENT_ID,
    FILE_KEY,
  );
  assert.equal(storedFile?.r2Key, fixture.file.r2Key);
  assert.equal(storedFile?.sha256, fixture.file.sha256);
  assert.deepEqual([...fixture.bucket.objects.keys()], [fixture.file.r2Key]);

  assert.equal(
    (await canonicalRequest(fixture, `/storage/records/${RECORD_KEY}`)).status,
    200,
  );
  assert.equal(
    (await canonicalRequest(fixture, `/storage/files/${FILE_KEY}`)).status,
    200,
  );

  const recordDelete = await canonicalRequest(
    fixture,
    `/storage/records/${RECORD_KEY}`,
    { method: "DELETE" },
  );
  assert.equal(recordDelete.status, 200);
  assertActions(await recordDelete.json(), [], ["create-record"]);
  const fileDelete = await canonicalRequest(
    fixture,
    `/storage/files/${FILE_KEY}`,
    { method: "DELETE" },
  );
  assert.equal(fileDelete.status, 200);
  assertActions(await fileDelete.json(), [], ["create-file"]);
  assert.equal(
    await fixture.store.getStorageRecord(
      fixture.user.id,
      BROWSER_SESSION_CLIENT_ID,
      RECORD_KEY,
    ),
    null,
  );
  assert.equal(
    await fixture.store.getStorageFileMetadata(
      fixture.user.id,
      BROWSER_SESSION_CLIENT_ID,
      FILE_KEY,
    ),
    null,
  );
  assert.equal(await fixture.bucket.get(fixture.file.r2Key), null);
});

async function killSwitchFixture(): Promise<KillSwitchFixture> {
  const bucket = new MemoryR2Bucket();
  const env = await testEnv({
    BUCKET: bucket,
    STORAGE_WRITES_ENABLED: "false",
  });
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const user = await store.findOrCreateUser(IDENTITY, nowSeconds());
  const seedLimits = { ...config.storageLimits, writesEnabled: true };
  assert.equal(
    await store.upsertStorageRecord(
      {
        userId: user.id,
        clientId: BROWSER_SESSION_CLIENT_ID,
        key: RECORD_KEY,
        valueJson: JSON.stringify({ original: true }),
        createdAt: 1,
        updatedAt: 1,
      },
      seedLimits,
    ),
    true,
  );

  const bytes = new TextEncoder().encode("original file bytes");
  const file: StorageFileMetadata = {
    userId: user.id,
    clientId: BROWSER_SESSION_CLIENT_ID,
    key: FILE_KEY,
    r2Key: "objects/task-156-existing",
    contentType: "text/plain",
    size: bytes.byteLength,
    sha256: await sha256(bytes),
    createdAt: 1,
    updatedAt: 1,
  };
  await bucket.put(file.r2Key, bytes, {
    httpMetadata: { contentType: file.contentType },
  });
  assert.equal(
    await store.upsertStorageFileMetadata(file, null, seedLimits),
    true,
  );

  const token = await issueBrowserSessionAccessToken(
    new Request(`${config.issuerUrl}/session`),
    testIdentityProvider(IDENTITY),
    store,
    config,
    ["storage.read", "storage.write", "storage.delete"],
  );
  assert.equal(typeof token, "string");
  return {
    app: createTestAittaDB(env, store, IDENTITY),
    bucket,
    config,
    env,
    store,
    token: token as string,
    user,
    file,
  };
}

async function sessionDocument(
  fixture: KillSwitchFixture,
  path: string,
  status: number,
): Promise<HypermediaDocumentValue> {
  const response = await requiredResponse(
    fixture.app.fetch(
      new Request(new URL(path, fixture.config.issuerUrl), {
        headers: { accept: VENDOR },
      }),
    ),
  );
  assert.equal(response.status, status, path);
  assert.equal(response.headers.get("aittadb-api-version"), "0.1");
  return (await response.json()) as HypermediaDocumentValue;
}

function canonicalRequest(
  fixture: KillSwitchFixture,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return requiredResponse(
    fixture.app.fetch(
      new Request(new URL(path, fixture.config.issuerUrl), {
        ...init,
        headers: {
          accept: VENDOR,
          authorization: `Bearer ${fixture.token}`,
          ...Object.fromEntries(new Headers(init.headers).entries()),
        },
      }),
    ),
  );
}

function assertActions(
  document: HypermediaDocumentValue | undefined,
  present: readonly string[],
  absent: readonly string[],
): void {
  assert.ok(document);
  const names = document.actions.map((action) => action.name);
  for (const name of present) assert.ok(names.includes(name), name);
  for (const name of absent) assert.equal(names.includes(name), false, name);
}

function assertNoWriteControls(page: string): void {
  assert.doesNotMatch(page, /<h3>(?:Create|Update|Upload|Replace)[^<]*<\/h3>/);
  assert.doesNotMatch(page, /name="_method" value="PUT"/);
  assert.doesNotMatch(page, /name="_method" value="POST"/);
  assert.doesNotMatch(page, /Open or (?:create|upload) one/);
}

async function assertDisabledJson(response: Response): Promise<void> {
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = (await response.json()) as HypermediaDocumentValue & {
    data: { error: string };
  };
  assert.equal(payload.data.error, "storage_writes_disabled");
  assert.deepEqual(payload.actions, []);
}

async function assertDisabledHtml(response: Response): Promise<void> {
  assert.equal(response.status, 503);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const page = await response.text();
  assert.match(page, /Storage writes are temporarily disabled/);
  assertNoWriteControls(page);
}

async function requiredResponse(
  response: Promise<Response | null>,
): Promise<Response> {
  const resolved = await response;
  assert.ok(resolved);
  return resolved;
}
