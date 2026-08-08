import assert from "node:assert/strict";
import test from "node:test";

import { createAittaDBWithStore } from "../../src/handler";
import { openApiSpec } from "../../src/openapi";
import { MemoryAuthStore } from "../../src/store/memory";
import type { AuthStore } from "../../src/types";
import { createTestAittaDB, testEnv, testIdentityProvider } from "../helpers";

const ISSUER = "https://aittadb.example.test";
const HYPERMEDIA = "application/vnd.aittadb+json; version=0.1";

test("disabled OAuth Apps rejects every external initiation route before request or repository work", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "false" });
  const observed = observeRepositoryCalls(new MemoryAuthStore());
  const scheduled: Promise<unknown>[] = [];
  const app = createAittaDBWithStore(
    env,
    observed.store,
    undefined,
    { waitUntil: (promise) => scheduled.push(promise) },
    testIdentityProvider(),
  );

  for (const path of [
    "/authorize?client_id=must-not-be-read",
    "/oauth/device_authorization",
    "/device?user_code=ABCDEFGH",
    "/consent?request_id=00000000-0000-4000-8000-000000000000",
  ]) {
    const response = await app.fetch(
      new Request(`${ISSUER}${path}`, { headers: { accept: HYPERMEDIA } }),
    );
    await assertUnavailable(response);
  }

  for (const path of [
    "/oauth/device_authorization",
    "/device",
    "/device/decision",
    "/consent",
  ]) {
    const tracked = streamedFormRequest(path);
    const response = await app.fetch(tracked.request);
    await assertUnavailable(response);
    assert.equal(tracked.pulls(), 0, `${path} must not pull its body`);
  }

  const html = await app.fetch(
    new Request(`${ISSUER}/device`, { headers: { accept: "text/html" } }),
  );
  assert.equal(html?.status, 503);
  assert.match(html?.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await html!.text(), /OAuth Apps is disabled/);

  const compatibleJson = await app.fetch(
    new Request(`${ISSUER}/oauth/device_authorization`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "client_id=must-not-be-read",
    }),
  );
  assert.equal(compatibleJson?.status, 503);
  assert.equal(
    compatibleJson?.headers.get("content-type"),
    "application/json; charset=utf-8",
  );

  const incompatible = await app.fetch(
    new Request(`${ISSUER}/authorize`, {
      headers: { accept: "application/vnd.aittadb+json; version=9" },
    }),
  );
  assert.equal(incompatible?.status, 406);

  assert.deepEqual(observed.calls, []);
  assert.deepEqual(scheduled, []);
});

test("disabled OAuth Apps omits initiation controls and preserves AittaDB's signed-in session", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "false" });
  const app = createTestAittaDB(env, new MemoryAuthStore());

  const rootResponse = await app.fetch(
    new Request(ISSUER, { headers: { accept: HYPERMEDIA } }),
  );
  assert.equal(rootResponse?.status, 200);
  const root = (await rootResponse!.json()) as ResourceDocument;
  assert.equal((root.data.features as { oauthApps: boolean }).oauthApps, false);
  assertMissingInitiationControls(root);
  assert.ok(root.links.some((item) => item.rel.includes("oauth-token")));
  assert.ok(root.links.some((item) => item.rel.includes("session")));

  const session = await app.fetch(
    new Request(`${ISSUER}/session`, { headers: { accept: HYPERMEDIA } }),
  );
  assert.equal(session?.status, 200);
  assert.equal(
    ((await session!.json()) as { data: { authenticated: boolean } }).data
      .authenticated,
    true,
  );

  const records = await app.fetch(
    new Request(`${ISSUER}/storage/records`, {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(records?.status, 200);
  assert.match(await records!.text(), /Current signed-in session/);
});

test("enabled OAuth Apps exposes and serves external initiation resources", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" });
  const app = createTestAittaDB(env, new MemoryAuthStore());

  const root = (await (await app.fetch(
    new Request(ISSUER, { headers: { accept: HYPERMEDIA } }),
  ))!.json()) as ResourceDocument;
  assert.ok(
    root.links.some((item) => item.rel.includes("oauth-authorization")),
  );
  assert.ok(
    root.links.some((item) => item.rel.includes("oauth-device-authorization")),
  );

  for (const path of ["/authorize", "/oauth/device_authorization", "/device"]) {
    const response = await app.fetch(
      new Request(`${ISSUER}${path}`, { headers: { accept: HYPERMEDIA } }),
    );
    assert.equal(response?.status, 200, path);
  }

  const consent = await app.fetch(
    new Request(`${ISSUER}/consent`, { headers: { accept: HYPERMEDIA } }),
  );
  assert.equal(consent?.status, 400);
});

test("OpenAPI documents every OAuth Apps initiation gate", () => {
  const operations = [
    ["/authorize", "get"],
    ["/oauth/device_authorization", "get"],
    ["/oauth/device_authorization", "post"],
    ["/device", "get"],
    ["/device", "post"],
    ["/device/decision", "post"],
    ["/consent", "get"],
    ["/consent", "post"],
  ] as const;

  const paths = openApiSpec.paths as unknown as Record<
    string,
    Record<
      string,
      {
        description: string;
        responses: Record<string, { description: string }>;
      }
    >
  >;
  for (const [path, method] of operations) {
    const operation = paths[path]?.[method];
    assert.ok(operation, `${method.toUpperCase()} ${path}`);
    assert.match(operation.description, /FEATURE_OAUTH_APPS_ENABLED/);
    assert.match(operation.responses["503"].description, /disabled/);
    assert.match(
      operation.responses["503"].description,
      /before client lookup/,
    );
    assert.match(operation.responses["503"].description, /signed-in session/);
  }
});

interface ResourceDocument {
  data: Record<string, unknown>;
  links: Array<{ rel: string[]; href: string }>;
  actions: Array<{ name: string; href: string }>;
}

async function assertUnavailable(
  response: Response | null | undefined,
): Promise<void> {
  assert.equal(response?.status, 503);
  assert.equal(response?.headers.get("cache-control"), "no-store");
  const document = (await response!.json()) as {
    error: string;
    data: { error: string; error_description: string };
  };
  assert.equal(document.error, "feature_unavailable");
  assert.equal(document.data.error, "feature_unavailable");
  assert.match(document.data.error_description, /OAuth Apps is disabled/);
}

function assertMissingInitiationControls(document: ResourceDocument): void {
  assert.ok(
    document.links.every(
      (item) =>
        !item.rel.includes("oauth-authorization") &&
        !item.rel.includes("oauth-device-authorization") &&
        !item.href.includes("/authorize") &&
        !item.href.includes("/oauth/device_authorization"),
    ),
  );
  assert.ok(
    document.actions.every(
      (item) =>
        !item.href.includes("/authorize") &&
        !item.href.includes("/oauth/device_authorization"),
    ),
  );
}

function streamedFormRequest(path: string): {
  request: Request;
  pulls(): number;
} {
  let pullCount = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new TextEncoder().encode("must_not_be_read=1"));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      accept: HYPERMEDIA,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    duplex: "half",
  };
  return {
    request: new Request(`${ISSUER}${path}`, init),
    pulls: () => pullCount,
  };
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
