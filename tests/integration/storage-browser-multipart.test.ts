import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_FILE_BYTES } from "../../src/storage";
import { MemoryAuthStore } from "../../src/store/memory";
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
