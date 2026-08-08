import assert from "node:assert/strict";
import { test } from "node:test";
import { createAittaDBWithStore } from "../../src/handler";
import { sitesIdentityProvider } from "../../src/identity";
import { MAX_FILE_BYTES } from "../../src/storage";
import { MemoryAuthStore } from "../../src/store/memory";
import type { AuthStore } from "../../src/types";
import {
  cookieValue,
  createTestAittaDB,
  MemoryR2Bucket,
  testEnv,
} from "../helpers";

const ORIGIN = "https://aittadb.example.test";
const MAX_FILE_FORM_BYTES = MAX_FILE_BYTES + 256 * 1024;

test("native multipart FormData uploads still persist normally", async () => {
  const { app, bucket, csrf, store } = await fixture();
  const form = new FormData();
  form.set("ui", "1");
  form.set("csrf_token", csrf);
  form.set("_method", "POST");
  form.set("auth_mode", "session");
  form.set(
    "file",
    new File(["bounded upload"], "bounded.txt", { type: "text/plain" }),
  );

  const response = await app.fetch(
    new Request(`${ORIGIN}/storage/files`, {
      method: "POST",
      headers: browserHeaders(csrf),
      body: form,
    }),
  );

  assert.equal(response?.status, 201);
  assert.equal(store.storageFiles.size, 1);
  assert.equal(bucket.objects.size, 1);
  const stored = Array.from(bucket.objects.values())[0];
  assert.equal(new TextDecoder().decode(stored?.body), "bounded upload");
});

test("the canonical file limit still rejects an oversized file", async () => {
  const { app, bucket, csrf, store } = await fixture();
  const form = new FormData();
  form.set("ui", "1");
  form.set("csrf_token", csrf);
  form.set("_method", "POST");
  form.set("auth_mode", "session");
  form.set(
    "file",
    new File([new Uint8Array(MAX_FILE_BYTES + 1)], "oversized.bin", {
      type: "application/octet-stream",
    }),
  );

  const response = await app.fetch(
    new Request(`${ORIGIN}/storage/files`, {
      method: "POST",
      headers: browserHeaders(csrf),
      body: form,
    }),
  );

  assert.equal(response?.status, 413);
  assert.match(await response!.text(), /Storage file is too large/);
  assert.equal(store.storageFiles.size, 0);
  assert.equal(bucket.objects.size, 0);
});

test("aggregate multipart limits ignore absent or untrustworthy lengths", async (t) => {
  const { app, bucket, csrf, store } = await fixture();
  const multipart = oversizedMultipart(csrf);
  assert.ok(multipart.body.byteLength > MAX_FILE_FORM_BYTES);

  const cases: ReadonlyArray<{
    name: string;
    contentLength?: string;
  }> = [
    {
      name: "accurate declared length",
      contentLength: String(multipart.body.byteLength),
    },
    { name: "missing declared length" },
    { name: "nonnumeric false length", contentLength: "false" },
    { name: "smaller declared length", contentLength: "1" },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const headers = browserHeaders(csrf);
      headers.set("content-type", multipart.contentType);
      if (testCase.contentLength !== undefined) {
        headers.set("content-length", testCase.contentLength);
      }
      const response = await app.fetch(
        new Request(`${ORIGIN}/storage/files`, {
          method: "POST",
          headers,
          body: copyBuffer(multipart.body),
        }),
      );

      assert.equal(response?.status, 413);
      const body = await response!.text();
      assert.match(body, /Storage browser form is too large/);
      assert.doesNotMatch(body, new RegExp(csrf));
      assert.equal(store.storageFiles.size, 0);
      assert.equal(bucket.objects.size, 0);
    });
  }
});

test("malformed bounded multipart is rejected without persistence", async () => {
  const { app, bucket, csrf, store } = await fixture();
  const headers = browserHeaders(csrf);
  headers.set("content-type", "multipart/form-data; boundary=broken");
  const response = await app.fetch(
    new Request(`${ORIGIN}/storage/files`, {
      method: "POST",
      headers,
      body: '--broken\r\nContent-Disposition: form-data; name="ui"\r\n',
    }),
  );

  assert.equal(response?.status, 400);
  assert.match(await response!.text(), /Malformed storage browser form/);
  assert.equal(store.storageFiles.size, 0);
  assert.equal(bucket.objects.size, 0);
});

test("untrusted identities are rejected before multipart streams or persistence are touched", async (t) => {
  const cases = [
    {
      name: "anonymous collection upload",
      path: "/storage/files",
      identityHeaders: {},
      returnTo: "%2Fstorage%2Ffiles",
    },
    {
      name: "malformed Sites identity on item replacement",
      path: "/storage/files/example.txt",
      identityHeaders: {
        "oai-authenticated-user-email": "not-an-email-address",
      },
      returnTo: "%2Fstorage%2Ffiles%2Fexample.txt",
    },
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const observed = await observedRuntime();
      const stream = trackedBody([
        new TextEncoder().encode("this multipart body must never be pulled"),
      ]);
      const headers = new Headers({
        accept: "text/html",
        origin: ORIGIN,
        "content-type": "multipart/form-data; boundary=never-parsed",
        ...testCase.identityHeaders,
      });
      const request = streamedPost(testCase.path, headers, stream.body);
      assert.equal(stream.pullCount(), 0);

      const response = await observed.app.fetch(request);

      assert.equal(response?.status, 302);
      assert.match(
        response?.headers.get("location") ?? "",
        new RegExp(`/signin-with-chatgpt\\?return_to=${testCase.returnTo}$`),
      );
      assert.equal(stream.pullCount(), 0);
      assert.deepEqual(observed.storeCalls, []);
      assert.deepEqual(observed.bucketCalls, []);
      assert.equal(observed.scheduled.length, 0);
      assert.equal(observed.store.storageFiles.size, 0);
      assert.equal(observed.bucket.objects.size, 0);
    });
  }
});

test("a valid same-origin Sites session parses a bounded streamed multipart upload", async () => {
  const observed = await observedRuntime();
  const identityHeaders = {
    "oai-authenticated-user-email": "stream-user@example.test",
  };
  const entry = await observed.app.fetch(
    new Request(`${ORIGIN}/storage/files`, {
      headers: { accept: "text/html", ...identityHeaders },
    }),
  );
  assert.equal(entry?.status, 200);
  const csrf = cookieValue(entry!, "aittadb_csrf");
  observed.storeCalls.length = 0;
  observed.bucketCalls.length = 0;
  observed.scheduled.length = 0;

  const form = new FormData();
  form.set("ui", "1");
  form.set("csrf_token", csrf);
  form.set("_method", "POST");
  form.set("auth_mode", "session");
  form.set(
    "file",
    new File(["streamed bounded upload"], "streamed.txt", {
      type: "text/plain",
    }),
  );
  const encoded = new Request(`${ORIGIN}/storage/files`, {
    method: "POST",
    body: form,
  });
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  assert.ok(bytes.byteLength < MAX_FILE_FORM_BYTES);
  const split = Math.ceil(bytes.byteLength / 2);
  const stream = trackedBody([bytes.slice(0, split), bytes.slice(split)]);
  const headers = browserHeaders(csrf);
  headers.set("content-type", encoded.headers.get("content-type") ?? "");
  headers.set(
    "oai-authenticated-user-email",
    identityHeaders["oai-authenticated-user-email"],
  );

  const response = await observed.app.fetch(
    streamedPost("/storage/files", headers, stream.body),
  );

  assert.equal(response?.status, 201);
  assert.ok(stream.pullCount() >= 2);
  assert.ok(observed.storeCalls.includes("findOrCreateUser"));
  assert.ok(observed.storeCalls.includes("upsertStorageFileMetadata"));
  assert.ok(observed.bucketCalls.includes("put"));
  assert.equal(observed.store.storageFiles.size, 1);
  assert.equal(observed.bucket.objects.size, 1);
});

async function fixture() {
  const env = await testEnv();
  const bucket = env.BUCKET as MemoryR2Bucket;
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);
  const entry = await app.fetch(
    new Request(`${ORIGIN}/storage/files`, {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(entry?.status, 200);
  return { app, bucket, csrf: cookieValue(entry!, "aittadb_csrf"), store };
}

function browserHeaders(csrf: string): Headers {
  return new Headers({
    accept: "application/json",
    cookie: `aittadb_csrf=${csrf}`,
    origin: ORIGIN,
  });
}

function oversizedMultipart(csrf: string): {
  body: Uint8Array;
  contentType: string;
} {
  const boundary = "aittadb-bounded-upload";
  const prefix = new TextEncoder().encode(
    field(boundary, "ui", "1") +
      field(boundary, "csrf_token", csrf) +
      field(boundary, "_method", "POST") +
      field(boundary, "auth_mode", "session") +
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="small.txt"\r\n' +
      "Content-Type: text/plain\r\n\r\n" +
      "small file\r\n" +
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="padding"\r\n\r\n',
  );
  const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const paddingBytes = MAX_FILE_BYTES + 300 * 1024;
  const body = new Uint8Array(
    prefix.byteLength + paddingBytes + suffix.byteLength,
  );
  body.set(prefix);
  body.fill(0x61, prefix.byteLength, prefix.byteLength + paddingBytes);
  body.set(suffix, prefix.byteLength + paddingBytes);
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function field(boundary: string, name: string, value: string): string {
  return (
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
    `${value}\r\n`
  );
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function observedRuntime() {
  const env = await testEnv();
  const store = new MemoryAuthStore();
  const bucket = env.BUCKET as MemoryR2Bucket;
  const observedStore = observeCalls(store);
  const observedBucket = observeCalls(bucket);
  const scheduled: Promise<unknown>[] = [];
  env.BUCKET = observedBucket.target as R2Bucket;
  const app = createAittaDBWithStore(
    env,
    observedStore.target as AuthStore,
    undefined,
    { waitUntil: (promise) => scheduled.push(promise) },
    sitesIdentityProvider,
  );
  return {
    app,
    bucket,
    bucketCalls: observedBucket.calls,
    scheduled,
    store,
    storeCalls: observedStore.calls,
  };
}

function observeCalls<T extends object>(
  target: T,
): { target: T; calls: string[] } {
  const calls: string[] = [];
  return {
    target: new Proxy(target, {
      get(current, property) {
        const value = Reflect.get(current, property, current) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(String(property));
          return Reflect.apply(value, current, args) as unknown;
        };
      },
    }),
    calls,
  };
}

function trackedBody(chunks: readonly Uint8Array[]): {
  body: ReadableStream<Uint8Array>;
  pullCount(): number;
} {
  let index = 0;
  let pulls = 0;
  return {
    body: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          const chunk = chunks[index];
          index += 1;
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
    pullCount: () => pulls,
  };
}

function streamedPost(
  path: string,
  headers: Headers,
  body: ReadableStream<Uint8Array>,
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}
