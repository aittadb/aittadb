import assert from "node:assert/strict";
import test from "node:test";

import { createAittaDBWithStore } from "../../src/handler";
import { openApiSpec } from "../../src/openapi";
import { MemoryAuthStore } from "../../src/store/memory";
import type { UpstreamIdentityProvider } from "../../src/identity";
import type { AuthStore } from "../../src/types";
import { createTestAittaDB, testEnv } from "../helpers";

const ISSUER = "https://aittadb.example.test";
const HYPERMEDIA = "application/vnd.aittadb+json; version=0.1";

test("disabled OAuth Apps rejects every token grant before request or repository work", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "false" });
  const observed = observeRepositoryCalls(new MemoryAuthStore());
  const scheduled: Promise<unknown>[] = [];
  let identityReads = 0;
  const identityProvider: UpstreamIdentityProvider = {
    read() {
      identityReads += 1;
      throw new Error("disabled token route must not inspect Sites identity");
    },
  };
  const app = createAittaDBWithStore(
    env,
    observed.store,
    undefined,
    { waitUntil: (promise) => scheduled.push(promise) },
    identityProvider,
  );

  for (const body of [
    "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=unread&device_code=unread",
    "grant_type=authorization_code&client_id=unread&code=unread&code_verifier=unread",
    "grant_type=refresh_token&client_id=unread&refresh_token=unread",
  ]) {
    const tracked = streamedTokenRequest(body);
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
    assert.equal(tracked.pulls(), 0, "disabled token POST must not pull body");
  }

  const htmlRequest = streamedTokenRequest("grant_type=refresh_token", {
    accept: "text/html",
  });
  const html = await app.fetch(htmlRequest.request);
  assert.equal(html?.status, 503);
  assert.match(html?.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await html!.text(), /OAuth Apps is disabled/);
  assert.equal(htmlRequest.pulls(), 0);

  assert.equal(identityReads, 0);
  assert.deepEqual(observed.calls, []);
  assert.deepEqual(scheduled, []);
});

test("disabled OAuth Apps hides the token operation and preserves the signed-in session", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "false" });
  const app = createTestAittaDB(env, new MemoryAuthStore());

  const rootResponse = await app.fetch(
    new Request(ISSUER, { headers: { accept: HYPERMEDIA } }),
  );
  assert.equal(rootResponse?.status, 200);
  const root = (await rootResponse!.json()) as ResourceDocument;
  assert.equal((root.data.features as { oauthApps: boolean }).oauthApps, false);
  assert.ok(
    root.links.every(
      (item) =>
        !item.rel.includes("oauth-token") &&
        !item.href.includes("/oauth/token"),
    ),
  );
  assert.ok(root.actions.every((item) => !item.href.includes("/oauth/token")));

  const tokenJson = await app.fetch(
    new Request(`${ISSUER}/oauth/token`, {
      headers: { accept: HYPERMEDIA },
    }),
  );
  assert.equal(tokenJson?.status, 503);
  assert.equal(
    ((await tokenJson!.json()) as { error: string }).error,
    "feature_unavailable",
  );

  const tokenHtml = await app.fetch(
    new Request(`${ISSUER}/oauth/token`, {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(tokenHtml?.status, 503);
  assert.match(tokenHtml?.headers.get("content-type") ?? "", /^text\/html/);

  const incompatible = await app.fetch(
    new Request(`${ISSUER}/oauth/token`, {
      headers: { accept: "application/vnd.aittadb+json; version=9" },
    }),
  );
  assert.equal(incompatible?.status, 406);

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

test("enabled OAuth Apps advertises and serves the token operation", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" });
  const app = createTestAittaDB(env, new MemoryAuthStore());

  const root = (await (await app.fetch(
    new Request(ISSUER, { headers: { accept: HYPERMEDIA } }),
  ))!.json()) as ResourceDocument;
  assert.ok(root.links.some((item) => item.rel.includes("oauth-token")));

  const token = await app.fetch(
    new Request(`${ISSUER}/oauth/token`, {
      headers: { accept: HYPERMEDIA },
    }),
  );
  assert.equal(token?.status, 200);
});

test("OpenAPI documents the OAuth Apps token gate", () => {
  const tokenPath = (
    openApiSpec.paths as unknown as Record<
      string,
      Record<
        string,
        {
          description: string;
          responses: Record<string, { description: string }>;
        }
      >
    >
  )["/oauth/token"];

  for (const method of ["get", "post"] as const) {
    assert.match(tokenPath[method].description, /FEATURE_OAUTH_APPS_ENABLED/);
    assert.match(tokenPath[method].responses["503"].description, /disabled/);
    assert.match(
      tokenPath[method].responses["503"].description,
      /before request-body reading/,
    );
    assert.match(
      tokenPath[method].responses["503"].description,
      /signed-in session/,
    );
  }
});

interface ResourceDocument {
  data: Record<string, unknown>;
  links: Array<{ rel: string[]; href: string }>;
  actions: Array<{ name: string; href: string }>;
}

function streamedTokenRequest(
  bodyText: string,
  headers: Record<string, string> = {},
): { request: Request; pulls(): number } {
  let pullCount = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new TextEncoder().encode(bodyText));
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
    request: new Request(`${ISSUER}/oauth/token`, init),
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
