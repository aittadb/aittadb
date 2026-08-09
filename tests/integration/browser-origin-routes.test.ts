import assert from "node:assert/strict";
import test from "node:test";
import { createAittaDBWithStore } from "../../src/handler";
import { MemoryAuthStore } from "../../src/store/memory";
import type { AuthStore, UpstreamIdentity } from "../../src/types";
import { MemoryR2Bucket, testEnv, testIdentityProvider } from "../helpers";

const ISSUER = "https://aittadb.example.test";
const DISPATCH_ORIGIN = "https://sites-dispatch.example.test";
const CSRF = "csrf_origin_route_test_value_000";
const IDENTITY: UpstreamIdentity = {
  email: "origin-route@example.test",
  fullName: "Origin Route",
  displayName: "Origin Route",
};

interface Payload {
  contentType: string;
  bytes: Uint8Array;
}

interface AdapterCase {
  name: string;
  family: "session" | "storage" | "account" | "privacy" | "administration";
  path: string;
  payload(csrf: string): Promise<Payload>;
  expectedStoreCall: string;
  expectedBucketCall?: "put" | "delete";
}

interface OriginCase {
  name: string;
  headers: Record<string, string>;
}

class ObservedBucket extends MemoryR2Bucket {
  readonly calls: string[] = [];

  override async put(
    ...args: Parameters<MemoryR2Bucket["put"]>
  ): ReturnType<MemoryR2Bucket["put"]> {
    this.calls.push("put");
    return super.put(...args);
  }

  override async get(
    ...args: Parameters<MemoryR2Bucket["get"]>
  ): ReturnType<MemoryR2Bucket["get"]> {
    this.calls.push("get");
    return super.get(...args);
  }

  override async delete(
    ...args: Parameters<MemoryR2Bucket["delete"]>
  ): ReturnType<MemoryR2Bucket["delete"]> {
    this.calls.push("delete");
    return super.delete(...args);
  }
}

test("every enabled browser mutation adapter rejects invalid origins before body or state", async () => {
  const fixture = await createFixture();
  const adapters = adapterCases(fixture.adminClientId);
  assert.deepEqual(
    [...new Set(adapters.map((adapter) => adapter.family))].sort(),
    ["account", "administration", "privacy", "session", "storage"],
  );
  const invalidOrigins: readonly OriginCase[] = [
    { name: "missing", headers: {} },
    { name: "malformed", headers: { origin: "not-an-origin" } },
    {
      name: "foreign",
      headers: { origin: "https://attacker.example.test" },
    },
    {
      name: "opaque cross-site",
      headers: { origin: "null", "sec-fetch-site": "cross-site" },
    },
    { name: "unauthorized null", headers: { origin: "null" } },
  ];

  for (const adapter of adapters) {
    for (const origin of invalidOrigins) {
      fixture.storeCalls.length = 0;
      fixture.bucket.calls.length = 0;
      fixture.scheduled.length = 0;
      const payload = await adapter.payload(CSRF);
      const counter = { pulls: 0 };
      const response = await fixture.app.fetch(
        requestWithCountedBody(adapter.path, payload, counter, origin.headers),
      );

      assert(response, `${adapter.name}: response`);
      assert.equal(response.status, 403, `${adapter.name}: ${origin.name}`);
      assert.equal(counter.pulls, 0, `${adapter.name}: body was pulled`);
      assert.deepEqual(
        fixture.storeCalls,
        [],
        `${adapter.name}: repository work preceded origin rejection`,
      );
      assert.deepEqual(
        fixture.bucket.calls,
        [],
        `${adapter.name}: R2 work preceded origin rejection`,
      );
      assert.equal(
        fixture.scheduled.length,
        0,
        `${adapter.name}: maintenance was scheduled before rejection`,
      );
    }
  }
});

test("valid origin and CSRF reach every enabled browser operation", async () => {
  const fixture = await createFixture();
  const adapters = adapterCases(fixture.adminClientId);

  for (const adapter of adapters) {
    fixture.storeCalls.length = 0;
    fixture.bucket.calls.length = 0;
    const payload = await adapter.payload(CSRF);
    const counter = { pulls: 0 };
    const response = await fixture.app.fetch(
      requestWithCountedBody(adapter.path, payload, counter, {
        origin: ISSUER,
      }),
    );

    assert(response, `${adapter.name}: response`);
    assert.notEqual(response.status, 403, `${adapter.name}: origin or CSRF`);
    assert.ok(counter.pulls > 0, `${adapter.name}: body was not parsed`);
    assert.ok(
      fixture.storeCalls.includes(adapter.expectedStoreCall),
      `${adapter.name}: did not reach ${adapter.expectedStoreCall}; calls=${fixture.storeCalls.join(",")}`,
    );
    if (adapter.expectedBucketCall) {
      assert.ok(
        fixture.bucket.calls.includes(adapter.expectedBucketCall),
        `${adapter.name}: did not reach R2 ${adapter.expectedBucketCall}`,
      );
    }
  }
});

test("machine OAuth and raw storage requests remain independent of browser origin", async () => {
  const fixture = await createFixture();
  const oauthPayload = urlEncodedPayload({
    client_id: "missing-client",
    grant_type: "refresh_token",
    refresh_token: "not-a-token",
  });
  const oauthCounter = { pulls: 0 };
  const oauthResponse = await fixture.app.fetch(
    requestWithCountedBody(
      "/oauth/token",
      oauthPayload,
      oauthCounter,
      {},
      "application/json",
    ),
  );
  assert(oauthResponse);
  assert.notEqual(oauthResponse.status, 403);
  assert.ok(oauthCounter.pulls > 0);

  const rawCounter = { pulls: 0 };
  const rawResponse = await fixture.app.fetch(
    requestWithCountedBody(
      "/storage/files",
      {
        contentType: "application/octet-stream",
        bytes: new TextEncoder().encode("raw API body"),
      },
      rawCounter,
      { authorization: "Bearer malformed" },
      "application/json",
    ),
  );
  assert(rawResponse);
  assert.notEqual(rawResponse.status, 403);
});

async function createFixture() {
  const target = new MemoryAuthStore();
  const admin = await target.findOrCreateUser(IDENTITY, 1_700_000_000);
  const adminClient = await target.createClient(
    {
      type: "public",
      name: "Origin route administration fixture",
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["openid"],
      origins: [],
    },
    null,
    1_700_000_000,
  );
  const storeCalls: string[] = [];
  const store = observeStore(target, storeCalls);
  const bucket = new ObservedBucket();
  const env = await testEnv({
    ADMIN_SUBJECTS: admin.id,
    BUCKET: bucket,
    FEATURE_OAUTH_APPS_ENABLED: "true",
  });
  const scheduled: Promise<unknown>[] = [];
  const app = createAittaDBWithStore(
    env,
    store,
    undefined,
    {
      waitUntil(promise) {
        scheduled.push(promise);
        void promise.catch(() => undefined);
      },
    },
    testIdentityProvider(IDENTITY),
  );
  return {
    app,
    adminClientId: adminClient.id,
    bucket,
    scheduled,
    storeCalls,
  };
}

function adapterCases(adminClientId: string): readonly AdapterCase[] {
  return [
    browserFormCase(
      "create device authorization",
      "account",
      "/oauth/device_authorization",
      {
        ui: "1",
        csrf_token: CSRF,
        client_id: "missing-client",
        scope: "openid",
      },
      "getClient",
    ),
    browserFormCase(
      "exchange token",
      "session",
      "/oauth/token",
      {
        ui: "1",
        csrf_token: CSRF,
        grant_type: "refresh_token",
        client_id: "missing-client",
        refresh_token: "not-a-token",
      },
      "getClient",
    ),
    browserFormCase(
      "revoke credential",
      "privacy",
      "/oauth/revoke",
      {
        ui: "1",
        csrf_token: CSRF,
        client_id: "missing-client",
        token: "not-a-token",
      },
      "getClient",
    ),
    browserFormCase(
      "introspect credential",
      "privacy",
      "/oauth/introspect",
      {
        ui: "1",
        csrf_token: CSRF,
        client_id: "missing-client",
        token: "not-a-token",
      },
      "getClient",
    ),
    browserFormCase(
      "read UserInfo with current session",
      "session",
      "/userinfo",
      { ui: "1", csrf_token: CSRF, auth_mode: "session" },
      "findOrCreateUser",
    ),
    browserFormCase(
      "replace JSON record",
      "storage",
      "/storage/records/origin-route-record",
      {
        ui: "1",
        csrf_token: CSRF,
        _method: "PUT",
        auth_mode: "session",
        value: '{"origin":"accepted"}',
      },
      "upsertStorageRecord",
    ),
    browserFormCase(
      "delete JSON record",
      "storage",
      "/storage/records/origin-route-record",
      {
        ui: "1",
        csrf_token: CSRF,
        _method: "DELETE",
        auth_mode: "session",
      },
      "deleteStorageRecord",
    ),
    multipartFormCase(
      "create file",
      "/storage/files",
      "POST",
      "origin-route-create.txt",
      "upsertStorageFileMetadata",
      "put",
    ),
    multipartFormCase(
      "replace file",
      "/storage/files/origin-route-file",
      "PUT",
      "origin-route-replace.txt",
      "upsertStorageFileMetadata",
      "put",
    ),
    browserFormCase(
      "delete file",
      "storage",
      "/storage/files/origin-route-file",
      {
        ui: "1",
        csrf_token: CSRF,
        _method: "DELETE",
        auth_mode: "session",
      },
      "deleteStorageFileMetadata",
      "delete",
    ),
    browserFormCase(
      "enter device code",
      "account",
      "/device",
      { csrf_token: CSRF, user_code: "ABCD-EFGH" },
      "getDeviceGrantByUserCodeHash",
    ),
    browserFormCase(
      "decide device grant",
      "account",
      "/device/decision",
      {
        csrf_token: CSRF,
        user_code: "ABCD-EFGH",
        decision: "deny",
      },
      "getDeviceGrantByUserCodeHash",
    ),
    browserFormCase(
      "decide authorization consent",
      "account",
      "/consent",
      {
        csrf_token: CSRF,
        request_id: "missing-request",
        decision: "deny",
      },
      "getAuthorizationRequest",
    ),
    browserFormCase(
      "create OAuth client",
      "administration",
      "/admin/clients",
      {
        csrf_token: CSRF,
        submission_token: "admin_submission_origin_test_001",
        name: "Created through origin route test",
        type: "public",
        redirect_uris: "https://created.example.test/callback",
        scopes: "openid",
        origins: "",
      },
      "createClient",
    ),
    browserFormCase(
      "mutate OAuth client",
      "administration",
      "/admin/clients",
      {
        csrf_token: CSRF,
        submission_token: "admin_submission_origin_test_002",
        action: "disable",
        client_id: adminClientId,
      },
      "setClientDisabled",
    ),
  ];
}

function browserFormCase(
  name: string,
  family: AdapterCase["family"],
  path: string,
  fields: Record<string, string>,
  expectedStoreCall: string,
  expectedBucketCall?: AdapterCase["expectedBucketCall"],
): AdapterCase {
  return {
    name,
    family,
    path,
    payload: async (csrf) => urlEncodedPayload({ ...fields, csrf_token: csrf }),
    expectedStoreCall,
    expectedBucketCall,
  };
}

function multipartFormCase(
  name: string,
  path: string,
  method: "POST" | "PUT",
  filename: string,
  expectedStoreCall: string,
  expectedBucketCall: AdapterCase["expectedBucketCall"],
): AdapterCase {
  return {
    name,
    family: "storage",
    path,
    payload: (csrf) => multipartPayload(csrf, method, filename),
    expectedStoreCall,
    expectedBucketCall,
  };
}

function urlEncodedPayload(fields: Record<string, string>): Payload {
  return {
    contentType: "application/x-www-form-urlencoded",
    bytes: new TextEncoder().encode(new URLSearchParams(fields).toString()),
  };
}

async function multipartPayload(
  csrf: string,
  method: "POST" | "PUT",
  filename: string,
): Promise<Payload> {
  const form = new FormData();
  form.set("ui", "1");
  form.set("csrf_token", csrf);
  form.set("_method", method);
  form.set("auth_mode", "session");
  form.set(
    "file",
    new File(["origin route file"], filename, { type: "text/plain" }),
  );
  const encoded = new Request(ISSUER, { method: "POST", body: form });
  return {
    contentType: encoded.headers.get("content-type") ?? "multipart/form-data",
    bytes: new Uint8Array(await encoded.arrayBuffer()),
  };
}

function requestWithCountedBody(
  path: string,
  payload: Payload,
  counter: { pulls: number },
  extraHeaders: Record<string, string>,
  accept = "text/html",
): Request {
  let sent = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        counter.pulls += 1;
        if (sent) {
          controller.close();
          return;
        }
        sent = true;
        controller.enqueue(payload.bytes);
      },
    },
    { highWaterMark: 0 },
  );
  const headers = new Headers({
    accept,
    "content-type": payload.contentType,
    cookie: `aittadb_csrf=${CSRF}`,
    ...extraHeaders,
  });
  return new Request(`${DISPATCH_ORIGIN}${path}`, {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function observeStore(target: MemoryAuthStore, calls: string[]): AuthStore {
  return new Proxy(target, {
    get(store, property, receiver) {
      const value = Reflect.get(store, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return Reflect.apply(value, store, args);
      };
    },
  }) as AuthStore;
}
