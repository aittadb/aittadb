import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryAuthStore } from "../../src/store/memory";
import {
  cookieValue,
  createTestAittaDB,
  MemoryR2Bucket,
  testEnv,
} from "../helpers";

const ORIGIN = "https://aittadb.example.test";
const CSRF_COOKIE = "aittadb_csrf";

test("a fresh upload form binds one CSRF token to its multipart submission", async () => {
  const { app, bucket, store } = await fixture();
  const form = await renderUploadForm(app);

  assert.equal(form.token, form.cookie);
  const response = await submitUpload(
    app,
    form.cookie,
    form.token,
    "fresh.txt",
    "fresh upload",
  );

  assert.equal(response.status, 303);
  const location = canonicalItemLocation(response);
  assert.equal(cookieValue(response, CSRF_COOKIE), form.cookie);
  assert.equal(store.metadataWrites, 1);
  assert.equal(bucket.objectWrites, 1);
  assert.equal(store.storageFiles.size, 1);
  assert.equal(bucket.objects.size, 1);

  const item = await renderItem(app, location, form.cookie);
  assert.equal(item.status, 200);
  const itemHtml = await item.text();
  const itemPath = new URL(location).pathname;
  const itemKey = decodeURIComponent(itemPath.slice("/storage/files/".length));
  assert.match(itemHtml, /<h2 id="file-details-heading">File details<\/h2>/);
  assert.match(itemHtml, new RegExp(itemKey));
  assert.equal(countExactActions(itemHtml, itemPath), 3);

  const refreshed = await renderItem(app, location, form.cookie);
  assert.equal(refreshed.status, 200);
  assert.equal(store.metadataWrites, 1);
  assert.equal(bucket.objectWrites, 1);
  assert.equal(store.storageFiles.size, 1);
  assert.equal(bucket.objects.size, 1);
});

test("concurrently opened upload forms reuse one valid CSRF session", async () => {
  const { app, bucket, store } = await fixture();
  const firstTab = await renderUploadForm(app);
  const [secondTab, thirdTab] = await Promise.all([
    renderUploadForm(app, firstTab.cookie),
    renderUploadForm(app, firstTab.cookie),
  ]);

  assert.equal(secondTab.cookie, firstTab.cookie);
  assert.equal(secondTab.token, firstTab.token);
  assert.equal(thirdTab.cookie, firstTab.cookie);
  assert.equal(thirdTab.token, firstTab.token);

  const [secondResponse, thirdResponse] = await Promise.all([
    submitUpload(
      app,
      secondTab.cookie,
      secondTab.token,
      "second.txt",
      "second tab",
    ),
    submitUpload(
      app,
      thirdTab.cookie,
      thirdTab.token,
      "third.txt",
      "third tab",
    ),
  ]);

  assert.equal(secondResponse.status, 303);
  assert.equal(thirdResponse.status, 303);
  canonicalItemLocation(secondResponse);
  canonicalItemLocation(thirdResponse);
  assert.equal(store.metadataWrites, 2);
  assert.equal(bucket.objectWrites, 2);
  assert.equal(store.storageFiles.size, 2);
  assert.equal(bucket.objects.size, 2);
});

test("a stale upload form fails without storage mutation and a fresh retry recovers", async () => {
  const { app, bucket, store } = await fixture();
  const staleForm = await renderUploadForm(app);
  const replacementCookie = "R".repeat(32);

  const rejected = await submitUpload(
    app,
    replacementCookie,
    staleForm.token,
    "stale.txt",
    "must not persist",
  );

  assert.equal(rejected.status, 403);
  assert.match(await rejected.text(), /CSRF validation failed/);
  assertNoStorageMutation(store, bucket);

  const retryForm = await renderUploadForm(app, replacementCookie);
  assert.equal(retryForm.cookie, replacementCookie);
  assert.equal(retryForm.token, replacementCookie);
  const recovered = await submitUpload(
    app,
    retryForm.cookie,
    retryForm.token,
    "recovered.txt",
    "fresh retry",
  );

  assert.equal(recovered.status, 303);
  canonicalItemLocation(recovered);
  assert.equal(store.metadataWrites, 1);
  assert.equal(bucket.objectWrites, 1);
  assert.equal(store.storageFiles.size, 1);
  assert.equal(bucket.objects.size, 1);
});

test("ChatGPT sign-in return preserves the upload form CSRF session", async () => {
  const env = await testEnv({ BUCKET: new MutationTrackingBucket() });
  const store = new MutationTrackingStore();
  const signedOutApp = createTestAittaDB(env, store, null);
  const signedInApp = createTestAittaDB(env, store);
  const beforeSignIn = await renderUploadForm(signedOutApp);

  const afterSignIn = await renderUploadForm(signedInApp, beforeSignIn.cookie);
  assert.equal(afterSignIn.cookie, beforeSignIn.cookie);
  assert.equal(afterSignIn.token, beforeSignIn.token);

  const response = await submitUpload(
    signedInApp,
    afterSignIn.cookie,
    afterSignIn.token,
    "after-sign-in.txt",
    "signed-in upload",
  );

  assert.equal(response.status, 303);
  canonicalItemLocation(response);
  assert.equal(cookieValue(response, CSRF_COOKIE), afterSignIn.cookie);
  assert.equal(store.metadataWrites, 1);
  assert.equal((env.BUCKET as MutationTrackingBucket).objectWrites, 1);
});

test("missing, mismatched, and malformed CSRF state cannot mutate file storage", async (t) => {
  const cases = [
    {
      name: "missing cookie",
      cookie: null,
      submitted: "A".repeat(32),
    },
    {
      name: "missing submitted token",
      cookie: "A".repeat(32),
      submitted: null,
    },
    {
      name: "mismatched valid tokens",
      cookie: "A".repeat(32),
      submitted: "B".repeat(32),
    },
    {
      name: "matching malformed tokens",
      cookie: "malformed",
      submitted: "malformed",
    },
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { app, bucket, store } = await fixture();
      const response = await submitUpload(
        app,
        testCase.cookie,
        testCase.submitted,
        "rejected.txt",
        "must not persist",
      );

      assert.equal(response.status, 403);
      assert.match(await response.text(), /CSRF validation failed/);
      assertNoStorageMutation(store, bucket);
    });
  }
});

class MutationTrackingStore extends MemoryAuthStore {
  metadataWrites = 0;
  metadataDeletes = 0;

  override async upsertStorageFileMetadata(
    ...args: Parameters<MemoryAuthStore["upsertStorageFileMetadata"]>
  ): Promise<boolean> {
    this.metadataWrites += 1;
    return super.upsertStorageFileMetadata(...args);
  }

  override async deleteStorageFileMetadata(
    ...args: Parameters<MemoryAuthStore["deleteStorageFileMetadata"]>
  ): Promise<boolean> {
    this.metadataDeletes += 1;
    return super.deleteStorageFileMetadata(...args);
  }
}

class MutationTrackingBucket extends MemoryR2Bucket {
  objectWrites = 0;
  objectDeletes = 0;

  override async put(
    ...args: Parameters<MemoryR2Bucket["put"]>
  ): Promise<unknown> {
    this.objectWrites += 1;
    return super.put(...args);
  }

  override async delete(
    ...args: Parameters<MemoryR2Bucket["delete"]>
  ): Promise<void> {
    this.objectDeletes += 1;
    return super.delete(...args);
  }
}

async function fixture() {
  const bucket = new MutationTrackingBucket();
  const env = await testEnv({ BUCKET: bucket });
  const store = new MutationTrackingStore();
  return { app: createTestAittaDB(env, store), bucket, store };
}

async function renderUploadForm(
  app: ReturnType<typeof createTestAittaDB>,
  cookie?: string,
): Promise<{ cookie: string; token: string }> {
  const headers = new Headers({ accept: "text/html" });
  if (cookie) headers.set("cookie", `${CSRF_COOKIE}=${cookie}`);
  const response = await app.fetch(
    new Request(`${ORIGIN}/storage/files`, { headers }),
  );
  assert.equal(response?.status, 200);
  const html = await response.text();
  const token = /name="csrf_token" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  assert.ok(token);
  return { cookie: cookieValue(response, CSRF_COOKIE), token };
}

async function submitUpload(
  app: ReturnType<typeof createTestAittaDB>,
  cookie: string | null,
  submittedToken: string | null,
  filename: string,
  content: string,
): Promise<Response> {
  const form = new FormData();
  form.set("ui", "1");
  if (submittedToken !== null) form.set("csrf_token", submittedToken);
  form.set("_method", "POST");
  form.set("auth_mode", "session");
  form.set("file", new File([content], filename, { type: "text/plain" }));
  const headers = new Headers({ accept: "text/html", origin: ORIGIN });
  if (cookie !== null) headers.set("cookie", `${CSRF_COOKIE}=${cookie}`);
  const response = await app.fetch(
    new Request(`${ORIGIN}/storage/files`, {
      method: "POST",
      headers,
      body: form,
    }),
  );
  assert.ok(response);
  return response;
}

function assertNoStorageMutation(
  store: MutationTrackingStore,
  bucket: MutationTrackingBucket,
): void {
  assert.equal(store.metadataWrites, 0);
  assert.equal(store.metadataDeletes, 0);
  assert.equal(bucket.objectWrites, 0);
  assert.equal(bucket.objectDeletes, 0);
  assert.equal(store.storageFiles.size, 0);
  assert.equal(bucket.objects.size, 0);
}

function canonicalItemLocation(response: Response): string {
  const location = response.headers.get("location") ?? "";
  assert.match(
    location,
    /^https:\/\/aittadb\.example\.test\/storage\/files\/[0-9a-f-]{36}$/,
  );
  return location;
}

async function renderItem(
  app: ReturnType<typeof createTestAittaDB>,
  location: string,
  cookie: string,
): Promise<Response> {
  const response = await app.fetch(
    new Request(location, {
      headers: {
        accept: "text/html",
        cookie: `${CSRF_COOKIE}=${cookie}`,
      },
    }),
  );
  assert.ok(response);
  assert.equal(cookieValue(response, CSRF_COOKIE), cookie);
  return response;
}

function countExactActions(html: string, pathname: string): number {
  return html.split(`action="${pathname}"`).length - 1;
}
