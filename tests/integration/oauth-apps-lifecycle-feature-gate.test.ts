import assert from "node:assert/strict";
import test from "node:test";

import { createAittaDBWithStore } from "../../src/handler";
import type { UpstreamIdentityProvider } from "../../src/identity";
import { openApiSpec } from "../../src/openapi";
import { MemoryAuthStore } from "../../src/store/memory";
import type { AuthStore } from "../../src/types";
import { createTestAittaDB, testEnv } from "../helpers";

const ISSUER = "https://aittadb.example.test";
const HYPERMEDIA = "application/vnd.aittadb+json; version=0.1";

test("disabled OAuth Apps rejects revocation and introspection before request or repository work", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "false" });
  const observed = observeRepositoryCalls(new MemoryAuthStore());
  const scheduled: Promise<unknown>[] = [];
  let identityReads = 0;
  const identityProvider: UpstreamIdentityProvider = {
    read() {
      identityReads += 1;
      throw new Error(
        "disabled lifecycle routes must not inspect Sites identity",
      );
    },
  };
  const app = createAittaDBWithStore(
    env,
    observed.store,
    undefined,
    { waitUntil: (promise) => scheduled.push(promise) },
    identityProvider,
  );

  for (const path of ["/oauth/revoke", "/oauth/introspect"]) {
    const tracked = streamedLifecycleRequest(path);
    const response = await app.fetch(tracked.request);
    assert.equal(response?.status, 503);
    assert.equal(
      response?.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    assert.equal(response?.headers.get("cache-control"), "no-store");
    const payload = (await response!.json()) as {
      error: string;
      error_description: string;
    };
    assert.equal(payload.error, "temporarily_unavailable");
    assert.match(payload.error_description, /OAuth Apps is disabled/);
    assert.equal(tracked.pulls(), 0, `${path} must not pull its body`);
  }

  const browser = streamedLifecycleRequest("/oauth/revoke", {
    accept: "text/html",
  });
  const html = await app.fetch(browser.request);
  assert.equal(html?.status, 503);
  assert.match(html?.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await html!.text(), /OAuth Apps is disabled/);
  assert.equal(browser.pulls(), 0);

  assert.equal(identityReads, 0);
  assert.deepEqual(observed.calls, []);
  assert.deepEqual(scheduled, []);
});

test("disabled OAuth Apps hides lifecycle resources and discovery endpoints", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "false" });
  const app = createTestAittaDB(env, new MemoryAuthStore());

  for (const path of ["/oauth/revoke", "/oauth/introspect"]) {
    const jsonResponse = await app.fetch(
      new Request(`${ISSUER}${path}`, { headers: { accept: HYPERMEDIA } }),
    );
    assert.equal(jsonResponse?.status, 503);
    assert.equal(
      ((await jsonResponse!.json()) as { error: string }).error,
      "feature_unavailable",
    );

    const htmlResponse = await app.fetch(
      new Request(`${ISSUER}${path}`, { headers: { accept: "text/html" } }),
    );
    assert.equal(htmlResponse?.status, 503);
    assert.match(
      htmlResponse?.headers.get("content-type") ?? "",
      /^text\/html/,
    );
  }

  const incompatible = await app.fetch(
    new Request(`${ISSUER}/oauth/introspect`, {
      headers: { accept: "application/vnd.aittadb+json; version=9" },
    }),
  );
  assert.equal(incompatible?.status, 406);

  const discovery = await discoveryDocument(app);
  assert.equal("revocation_endpoint" in discovery, false);
  assert.equal("introspection_endpoint" in discovery, false);

  const session = await app.fetch(
    new Request(`${ISSUER}/session`, { headers: { accept: HYPERMEDIA } }),
  );
  assert.equal(session?.status, 200);
  assert.equal(
    ((await session!.json()) as { data: { authenticated: boolean } }).data
      .authenticated,
    true,
  );
});

test("enabled OAuth Apps exposes lifecycle resources and discovery endpoints", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" });
  const app = createTestAittaDB(env, new MemoryAuthStore());

  for (const path of ["/oauth/revoke", "/oauth/introspect"]) {
    const response = await app.fetch(
      new Request(`${ISSUER}${path}`, { headers: { accept: HYPERMEDIA } }),
    );
    assert.equal(response?.status, 200);
  }

  const discovery = await discoveryDocument(app);
  assert.equal(discovery.revocation_endpoint, `${ISSUER}/oauth/revoke`);
  assert.equal(discovery.introspection_endpoint, `${ISSUER}/oauth/introspect`);
});

test("OpenAPI documents both OAuth Apps lifecycle gates", () => {
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

  for (const path of ["/oauth/revoke", "/oauth/introspect"]) {
    for (const method of ["get", "post"] as const) {
      const operation = paths[path][method];
      assert.match(operation.description, /FEATURE_OAUTH_APPS_ENABLED/);
      assert.match(operation.responses["503"].description, /disabled/);
      assert.match(
        operation.responses["503"].description,
        /before request-body reading/,
      );
      assert.match(operation.responses["503"].description, /discovery omits/);
    }
  }
});

async function discoveryDocument(
  app: ReturnType<typeof createTestAittaDB>,
): Promise<Record<string, unknown>> {
  const response = await app.fetch(
    new Request(`${ISSUER}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(response?.status, 200);
  return (await response!.json()) as Record<string, unknown>;
}

function streamedLifecycleRequest(
  path: string,
  headers: Record<string, string> = {},
): { request: Request; pulls(): number } {
  let pullCount = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pullCount += 1;
        controller.enqueue(
          new TextEncoder().encode(
            "token=must-not-be-read&client_id=must-not-be-read",
          ),
        );
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
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
