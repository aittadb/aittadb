import assert from "node:assert/strict";
import test from "node:test";

import { createAittaDBWithStore } from "../../src/handler";
import { MemoryAuthStore } from "../../src/store/memory";
import type { AuthStore } from "../../src/types";
import {
  createTestAittaDB,
  MemoryR2Bucket,
  testEnv,
  testIdentityProvider,
} from "../helpers";

const HYPERMEDIA_ACCEPT = "application/vnd.aittadb+json; version=0.1";

test("disabled File Storage rejects every route before D1, R2, or cleanup work", async () => {
  const env = await testEnv({ FEATURE_FILES_ENABLED: "false" });
  const observedStore = observeCalls(new MemoryAuthStore());
  const observedBucket = observeCalls(env.BUCKET as MemoryR2Bucket);
  env.BUCKET = observedBucket.target as R2Bucket;
  const scheduled: Promise<unknown>[] = [];
  const app = createAittaDBWithStore(
    env,
    observedStore.target as AuthStore,
    undefined,
    { waitUntil: (promise) => scheduled.push(promise) },
    testIdentityProvider(),
  );

  const requests = [
    request("GET", "/storage/files"),
    request("POST", "/storage/files", "file body", "application/octet-stream"),
    request("POST", "/storage/files", "ui=1&_method=GET"),
    request(
      "GET",
      "/storage/files/private.bin",
      undefined,
      undefined,
      "application/octet-stream",
    ),
    request("POST", "/storage/files/private.bin", "ui=1&_method=DELETE"),
    request(
      "PUT",
      "/storage/files/private.bin",
      "replacement",
      "application/octet-stream",
    ),
    request("DELETE", "/storage/files/private.bin"),
    request("OPTIONS", "/storage/files"),
  ];

  for (const candidate of requests) {
    const response = await app.fetch(candidate);
    assert.equal(response?.status, 503);
    assert.match(
      response?.headers.get("content-type") ?? "",
      /^application\/(?:vnd\.aittadb\+json; version=0\.1|json)/,
    );
    assert.equal(response?.headers.get("cache-control"), "no-store");
    const payload = (await response?.json()) as ResourceDocument & {
      error: string;
      data: { error: string; error_description: string };
    };
    assert.equal(payload.type, "error");
    assert.equal(payload.error, "feature_unavailable");
    assert.equal(payload.data.error, "feature_unavailable");
    assert.match(payload.data.error_description, /File Storage is disabled/);
    assert.ok(payload.links.some((item) => item.rel.includes("service")));
    assert.ok(payload.actions.some((item) => item.name === "open-service"));
  }

  const htmlResponse = await app.fetch(
    new Request("https://aittadb.example.test/storage/files/private.bin", {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(htmlResponse?.status, 503);
  assert.match(htmlResponse?.headers.get("content-type") ?? "", /^text\/html/);
  const htmlBody = await htmlResponse?.text();
  assert.match(htmlBody ?? "", /Service unavailable/);
  assert.match(htmlBody ?? "", /File Storage is disabled for this deployment/);
  assert.match(htmlBody ?? "", /feature_unavailable/);

  const compatibilityResponse = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(compatibilityResponse?.status, 503);
  assert.equal(
    compatibilityResponse?.headers.get("content-type"),
    "application/json; charset=utf-8",
  );

  const unsupportedResponse = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
      headers: { accept: "application/vnd.aittadb+json; version=9" },
    }),
  );
  assert.equal(unsupportedResponse?.status, 406);
  assert.equal(
    ((await unsupportedResponse?.json()) as { error: string }).error,
    "not_acceptable",
  );

  assert.deepEqual(observedStore.calls, []);
  assert.deepEqual(observedBucket.calls, []);
  assert.deepEqual(scheduled, []);
});

test("disabled File Storage disappears from HTML and hypermedia discovery only", async () => {
  const env = await testEnv({
    FEATURE_FILES_ENABLED: "false",
    PRIVACY_CONTROLLER_NAME: "AittaDB Test Operator",
    PRIVACY_CONTACT_EMAIL: "privacy@example.test",
  });
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);

  const root = (await (
    await app.fetch(apiRequest("/"))
  )?.json()) as ResourceDocument;
  assert.equal((root.data.features as { files: boolean }).files, false);
  assert.ok(
    !(root.data.capabilities as string[]).some((value) =>
      /R2-backed files/i.test(value),
    ),
  );
  assertMissingFileControls(root);
  assertHasRelation(root, "storage-records");
  assertHasRelation(root, "statistics");

  const rootHtml = await fetchHtml(app, "/");
  assert.match(rootHtml, /Files off/);
  assert.doesNotMatch(rootHtml, /href="\/storage\/files/);
  assert.match(rootHtml, /href="\/storage\/records"/);
  assert.match(rootHtml, /href="\/statistics"/);

  const session = (await (
    await app.fetch(apiRequest("/session"))
  )?.json()) as ResourceDocument;
  assertMissingFileControls(session);
  assertHasRelation(session, "storage-records");
  assertHasRelation(session, "userinfo");

  const sessionHtml = await fetchHtml(app, "/session");
  assert.doesNotMatch(sessionHtml, /href="\/storage\/files/);
  assert.match(sessionHtml, /href="\/storage\/records"/);
  assert.match(sessionHtml, /Sign out/);

  const records = (await (
    await app.fetch(apiRequest("/storage/records"))
  )?.json()) as ResourceDocument;
  assertMissingFileControls(records);
  assert.ok(records.actions.some((item) => item.name === "list-records"));

  const recordsHtml = await fetchHtml(app, "/storage/records");
  assert.match(recordsHtml, /JSON record storage/);
  assert.doesNotMatch(recordsHtml, /href="\/storage\/files/);

  for (const path of ["/statistics", "/health", "/privacy"] as const) {
    const response = await app.fetch(apiRequest(path));
    assert.equal(response?.status, 200, `${path} remains available`);
  }
});

test("enabled File Storage preserves route and discovery behavior", async () => {
  const env = await testEnv();
  const app = createTestAittaDB(env, new MemoryAuthStore());

  const root = (await (
    await app.fetch(apiRequest("/"))
  )?.json()) as ResourceDocument;
  assert.equal((root.data.features as { files: boolean }).files, true);
  assertHasRelation(root, "storage-files");
  assert.ok(root.actions.some((item) => item.name === "open-files"));

  const filesResponse = await app.fetch(apiRequest("/storage/files"));
  assert.equal(filesResponse?.status, 200);
  const files = (await filesResponse?.json()) as ResourceDocument;
  assert.equal(files.type, "storage-files-collection");
  assert.ok(files.actions.some((item) => item.name === "list-files"));
  assert.ok(files.actions.some((item) => item.name === "create-file"));

  const filesHtml = await fetchHtml(app, "/storage/files");
  assert.match(filesHtml, /File object storage/);
  assert.match(filesHtml, /Upload new file/);
});

interface ResourceDocument {
  type: string;
  data: Record<string, unknown>;
  links: Array<{ rel: string[]; href: string }>;
  actions: Array<{ name: string; href: string }>;
}

function request(
  method: string,
  pathname: string,
  body?: string,
  contentType = "application/x-www-form-urlencoded",
  accept = HYPERMEDIA_ACCEPT,
): Request {
  const headers = new Headers({
    accept,
    authorization: "Bearer intentionally-invalid",
    origin: "https://client.example.test",
  });
  if (body !== undefined) headers.set("content-type", contentType);
  return new Request(`https://aittadb.example.test${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

function apiRequest(pathname: string): Request {
  return new Request(`https://aittadb.example.test${pathname}`, {
    headers: { accept: HYPERMEDIA_ACCEPT },
  });
}

async function fetchHtml(
  app: { fetch(request: Request): Promise<Response | null> },
  pathname: string,
): Promise<string> {
  const response = await app.fetch(
    new Request(`https://aittadb.example.test${pathname}`, {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(response?.status, 200);
  return (await response?.text()) ?? "";
}

function assertMissingFileControls(document: ResourceDocument): void {
  assert.ok(
    document.links.every(
      (item) =>
        !item.rel.includes("storage-files") &&
        !item.href.includes("/storage/files"),
    ),
  );
  assert.ok(
    document.actions.every(
      (item) =>
        !item.name.includes("file") && !item.href.includes("/storage/files"),
    ),
  );
}

function assertHasRelation(document: ResourceDocument, relation: string): void {
  assert.ok(document.links.some((item) => item.rel.includes(relation)));
}

function observeCalls(target: object): { target: object; calls: string[] } {
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
