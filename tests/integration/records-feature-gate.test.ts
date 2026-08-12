import assert from "node:assert/strict";
import test from "node:test";

import { createAittaDBWithStore } from "../../src/handler";
import { MemoryAuthStore } from "../../src/store/memory";
import type { AuthStore } from "../../src/types";
import { createTestAittaDB, testEnv, testIdentityProvider } from "../helpers";

const HYPERMEDIA_ACCEPT = "application/vnd.aittadb+json; version=0.1";

test("disabled JSON Records rejects every route before repository work", async () => {
  const env = await testEnv({ FEATURE_RECORDS_ENABLED: "false" });
  const observed = observeRepositoryCalls(new MemoryAuthStore());
  const scheduled: Promise<unknown>[] = [];
  const app = createAittaDBWithStore(
    env,
    observed.store,
    undefined,
    { waitUntil: (promise) => scheduled.push(promise) },
    testIdentityProvider(),
  );

  const requests = [
    request("GET", "/storage/record-protocol"),
    request(
      "GET",
      "/storage/record-protocol/records?collection=settings&limit=100",
    ),
    request("GET", "/storage/record-protocol/records/settings/example"),
    request(
      "POST",
      "/storage/record-protocol/transactions",
      "transaction=%7B%7D",
    ),
    request("GET", "/storage/records"),
    request("POST", "/storage/records", "ui=1&_method=GET"),
    request("GET", "/storage/records/app%2Fsettings"),
    request("POST", "/storage/records/app%2Fsettings", "ui=1&_method=PUT"),
    request("PUT", "/storage/records/app%2Fsettings", '{"theme":"dark"}'),
    request("DELETE", "/storage/records/app%2Fsettings"),
    request("OPTIONS", "/storage/records"),
  ];

  for (const candidate of requests) {
    const response = await app.fetch(candidate);
    assert.equal(response?.status, 503);
    assert.match(
      response?.headers.get("content-type") ?? "",
      /^application\/vnd\.aittadb\+json; version=0\.1/,
    );
    assert.equal(response?.headers.get("cache-control"), "no-store");
    const payload = (await response?.json()) as {
      type: string;
      error: string;
      data: { error: string; error_description: string };
      links: Array<{ rel: string[]; href: string }>;
      actions: Array<{ name: string; href: string }>;
    };
    assert.equal(payload.type, "error");
    assert.equal(payload.error, "feature_unavailable");
    assert.equal(payload.data.error, "feature_unavailable");
    assert.match(payload.data.error_description, /JSON Records is disabled/);
    assert.ok(payload.links.some((item) => item.rel.includes("service")));
    assert.ok(payload.actions.some((item) => item.name === "open-service"));
  }

  const htmlResponse = await app.fetch(
    new Request("https://aittadb.example.test/storage/records/private", {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(htmlResponse?.status, 503);
  assert.match(htmlResponse?.headers.get("content-type") ?? "", /^text\/html/);
  const htmlBody = await htmlResponse?.text();
  assert.match(htmlBody ?? "", /Service unavailable/);
  assert.match(htmlBody ?? "", /JSON Records is disabled for this deployment/);
  assert.match(htmlBody ?? "", /feature_unavailable/);

  const compatibilityResponse = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(compatibilityResponse?.status, 503);
  assert.equal(
    compatibilityResponse?.headers.get("content-type"),
    "application/json; charset=utf-8",
  );

  const unsupportedResponse = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      headers: { accept: "application/vnd.aittadb+json; version=9" },
    }),
  );
  assert.equal(unsupportedResponse?.status, 406);
  assert.equal(
    ((await unsupportedResponse?.json()) as { error: string }).error,
    "not_acceptable",
  );

  assert.deepEqual(observed.calls, []);
  assert.deepEqual(scheduled, []);
});

test("disabled JSON Records disappears from HTML and hypermedia discovery only", async () => {
  const env = await testEnv({
    FEATURE_RECORDS_ENABLED: "false",
    FEATURE_OAUTH_APPS_ENABLED: "true",
    PRIVACY_CONTROLLER_NAME: "AittaDB Test Operator",
    PRIVACY_CONTACT_EMAIL: "privacy@example.test",
  });
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);

  const rootResponse = await app.fetch(apiRequest("/"));
  assert.equal(rootResponse?.status, 200);
  const root = (await rootResponse?.json()) as ResourceDocument;
  assert.equal((root.data.features as { records: boolean }).records, false);
  assert.ok(
    !(root.data.capabilities as string[]).some((value) =>
      /JSON records/i.test(value),
    ),
  );
  assertMissingRecordsControls(root);
  assertHasRelation(root, "storage-files");
  assertHasRelation(root, "statistics");

  const rootHtml = await fetchHtml(app, "/");
  assert.match(rootHtml, /Records off/);
  assert.doesNotMatch(rootHtml, /href="\/storage\/records"/);
  assert.match(rootHtml, /href="\/storage\/files"/);
  assert.match(rootHtml, /href="\/statistics"/);

  const sessionResponse = await app.fetch(apiRequest("/session"));
  assert.equal(sessionResponse?.status, 200);
  const session = (await sessionResponse?.json()) as ResourceDocument;
  assert.equal(
    (session.data as { authenticated: boolean }).authenticated,
    true,
  );
  assertMissingRecordsControls(session);
  assertHasRelation(session, "storage-files");
  assertHasRelation(session, "userinfo");

  const sessionHtml = await fetchHtml(app, "/session");
  assert.doesNotMatch(sessionHtml, /href="\/storage\/records"/);
  assert.match(sessionHtml, /href="\/storage\/files"/);
  assert.match(sessionHtml, /Sign out/);

  const filesResponse = await app.fetch(apiRequest("/storage/files"));
  assert.equal(filesResponse?.status, 200);
  const files = (await filesResponse?.json()) as ResourceDocument;
  assertMissingRecordsControls(files);
  assert.ok(files.actions.some((item) => item.name === "create-file"));

  const filesHtml = await fetchHtml(app, "/storage/files");
  assert.match(filesHtml, /File object storage/);
  assert.match(filesHtml, /Upload new file/);
  assert.doesNotMatch(filesHtml, /href="\/storage\/records"/);

  for (const path of ["/statistics", "/health", "/privacy"] as const) {
    const response = await app.fetch(apiRequest(path));
    assert.equal(response?.status, 200, `${path} remains available`);
  }
});

test("enabled JSON Records preserves route and discovery behavior", async () => {
  const env = await testEnv();
  const app = createTestAittaDB(env, new MemoryAuthStore());

  const root = (await (
    await app.fetch(apiRequest("/"))
  )?.json()) as ResourceDocument;
  assert.equal((root.data.features as { records: boolean }).records, true);
  assertHasRelation(root, "storage-records");
  assertHasRelation(root, "bounded-record-storage");
  assert.ok(root.actions.some((item) => item.name === "open-records"));
  assert.ok(
    root.actions.some((item) => item.name === "open-bounded-record-storage"),
  );

  const recordsResponse = await app.fetch(apiRequest("/storage/records"));
  assert.equal(recordsResponse?.status, 200);
  const records = (await recordsResponse?.json()) as ResourceDocument;
  assert.equal(records.type, "storage-records-collection");
  assert.ok(records.actions.some((item) => item.name === "list-records"));

  const recordsHtml = await fetchHtml(app, "/storage/records");
  assert.match(recordsHtml, /JSON record storage/);
  assert.match(recordsHtml, /List records/);

  const protocolHtml = await fetchHtml(app, "/storage/record-protocol");
  assert.match(protocolHtml, /Bounded record storage/);
  assert.match(protocolHtml, /Run transaction/);
});

interface ResourceDocument {
  type: string;
  data: Record<string, unknown>;
  links: Array<{ rel: string[]; href: string }>;
  actions: Array<{ name: string; href: string }>;
}

function request(method: string, pathname: string, body?: string): Request {
  const headers = new Headers({
    accept: HYPERMEDIA_ACCEPT,
    authorization: "Bearer intentionally-invalid",
    origin: "https://client.example.test",
  });
  if (body !== undefined) {
    headers.set(
      "content-type",
      method === "PUT"
        ? "application/json"
        : "application/x-www-form-urlencoded",
    );
  }
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
  assert.match(response?.headers.get("content-type") ?? "", /^text\/html/);
  return (await response?.text()) ?? "";
}

function assertMissingRecordsControls(document: ResourceDocument): void {
  assert.ok(
    document.links.every(
      (item) =>
        !item.rel.includes("storage-records") &&
        !item.rel.includes("bounded-record-storage") &&
        !item.href.includes("/storage/records") &&
        !item.href.includes("/storage/record-protocol"),
    ),
  );
  assert.ok(
    document.actions.every(
      (item) =>
        !item.name.includes("record") &&
        !item.href.includes("/storage/records") &&
        !item.href.includes("/storage/record-protocol"),
    ),
  );
}

function assertHasRelation(document: ResourceDocument, relation: string): void {
  assert.ok(document.links.some((item) => item.rel.includes(relation)));
}

function observeRepositoryCalls(target: MemoryAuthStore): {
  store: AuthStore;
  calls: string[];
} {
  const calls: string[] = [];
  const store = new Proxy(target, {
    get(current, property) {
      const value = Reflect.get(current, property, current) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return Reflect.apply(value, current, args) as unknown;
      };
    },
  }) as AuthStore;
  return { store, calls };
}
