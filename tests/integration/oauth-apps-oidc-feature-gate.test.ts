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

test("disabled OAuth Apps rejects UserInfo before bearer, body, identity, or repository work", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "false" });
  const observed = observeRepositoryCalls(new MemoryAuthStore());
  const scheduled: Promise<unknown>[] = [];
  let identityReads = 0;
  const identityProvider: UpstreamIdentityProvider = {
    read() {
      identityReads += 1;
      throw new Error("disabled UserInfo must not inspect Sites identity");
    },
  };
  const app = createAittaDBWithStore(
    env,
    observed.store,
    undefined,
    { waitUntil: (promise) => scheduled.push(promise) },
    identityProvider,
  );

  const bearer = await app.fetch(
    new Request(`${ISSUER}/userinfo`, {
      headers: {
        accept: "application/json",
        authorization: "Bearer must-not-be-parsed",
      },
    }),
  );
  assert.equal(bearer?.status, 503);
  assert.equal(bearer?.headers.get("cache-control"), "no-store");
  assert.equal(
    ((await bearer!.json()) as { error: string }).error,
    "feature_unavailable",
  );

  const tracked = streamedUserInfoRequest();
  const post = await app.fetch(tracked.request);
  assert.equal(post?.status, 503);
  assert.equal(
    ((await post!.json()) as { error: string }).error,
    "feature_unavailable",
  );
  assert.equal(tracked.pulls(), 0);

  const html = await app.fetch(
    new Request(`${ISSUER}/userinfo`, { headers: { accept: "text/html" } }),
  );
  assert.equal(html?.status, 503);
  assert.match(html?.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await html!.text(), /OAuth Apps is disabled/);

  const incompatible = await app.fetch(
    new Request(`${ISSUER}/userinfo`, {
      headers: { accept: "application/vnd.aittadb+json; version=9" },
    }),
  );
  assert.equal(incompatible?.status, 406);

  assert.equal(identityReads, 0);
  assert.deepEqual(observed.calls, []);
  assert.deepEqual(scheduled, []);
});

test("disabled OAuth Apps publishes verification-only issuer metadata and public-only JWKS", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "false" });
  const observed = observeRepositoryCalls(new MemoryAuthStore());
  let identityReads = 0;
  const app = createAittaDBWithStore(
    env,
    observed.store,
    undefined,
    undefined,
    {
      read() {
        identityReads += 1;
        return null;
      },
    },
  );

  const discovery = await discoveryDocument(app);
  assert.deepEqual(Object.keys(discovery).sort(), [
    "id_token_signing_alg_values_supported",
    "issuer",
    "jwks_uri",
  ]);
  assert.equal(discovery.issuer, ISSUER);
  assert.equal(discovery.jwks_uri, `${ISSUER}/.well-known/jwks.json`);
  assert.deepEqual(discovery.id_token_signing_alg_values_supported, ["ES256"]);

  const response = await app.fetch(
    new Request(`${ISSUER}/.well-known/jwks.json`, {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(response?.status, 200);
  const jwks = (await response!.json()) as {
    keys: Array<Record<string, unknown>>;
  };
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0]?.kid, "test-key");
  assert.equal(jwks.keys[0]?.alg, "ES256");
  assert.equal(jwks.keys[0]?.kty, "EC");
  assert.equal(jwks.keys[0]?.crv, "P-256");
  assert.equal("d" in jwks.keys[0]!, false);
  assert.equal(typeof jwks.keys[0]?.x, "string");
  assert.equal(typeof jwks.keys[0]?.y, "string");
  assert.equal(identityReads, 0);
  assert.deepEqual(observed.calls, []);
});

test("disabled OAuth Apps removes UserInfo from signed-in HTML and hypermedia", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "false" });
  const app = createTestAittaDB(env, new MemoryAuthStore());

  const hypermedia = await app.fetch(
    new Request(`${ISSUER}/session`, { headers: { accept: HYPERMEDIA } }),
  );
  assert.equal(hypermedia?.status, 200);
  const document = (await hypermedia!.json()) as {
    links: Array<{ rel: string[]; href: string }>;
    actions: Array<{ name: string; href: string }>;
  };
  assert.ok(
    document.links.every(
      (item) =>
        !item.rel.includes("userinfo") && !item.href.includes("/userinfo"),
    ),
  );
  assert.ok(
    document.actions.every(
      (item) =>
        item.name !== "read-userinfo-with-session" &&
        !item.href.includes("/userinfo"),
    ),
  );

  const html = await app.fetch(
    new Request(`${ISSUER}/session`, { headers: { accept: "text/html" } }),
  );
  assert.equal(html?.status, 200);
  const body = await html!.text();
  assert.doesNotMatch(body, /My identity claims/);
  assert.doesNotMatch(body, /href="\/userinfo"/);
  assert.match(body, /My JSON records/);
});

test("enabled OAuth Apps retains complete discovery and UserInfo operations", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" });
  const app = createTestAittaDB(env, new MemoryAuthStore());

  const discovery = await discoveryDocument(app);
  assert.equal(discovery.authorization_endpoint, `${ISSUER}/authorize`);
  assert.equal(discovery.token_endpoint, `${ISSUER}/oauth/token`);
  assert.equal(discovery.revocation_endpoint, `${ISSUER}/oauth/revoke`);
  assert.equal(discovery.introspection_endpoint, `${ISSUER}/oauth/introspect`);
  assert.equal(discovery.userinfo_endpoint, `${ISSUER}/userinfo`);
  assert.deepEqual(discovery.grant_types_supported, [
    "authorization_code",
    "urn:ietf:params:oauth:grant-type:device_code",
    "refresh_token",
    "client_credentials",
  ]);

  const descriptor = await app.fetch(
    new Request(`${ISSUER}/userinfo`, { headers: { accept: HYPERMEDIA } }),
  );
  assert.equal(descriptor?.status, 200);

  const session = await app.fetch(
    new Request(`${ISSUER}/session`, { headers: { accept: HYPERMEDIA } }),
  );
  const document = (await session!.json()) as {
    links: Array<{ rel: string[]; href: string }>;
    actions: Array<{ name: string; href: string }>;
  };
  assert.ok(document.links.some((item) => item.rel.includes("userinfo")));
  assert.ok(
    document.actions.some((item) => item.name === "read-userinfo-with-session"),
  );
});

test("OpenAPI documents the UserInfo gate and verification-only metadata", () => {
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

  for (const method of ["get", "post"] as const) {
    const userInfo = paths["/userinfo"]![method]!;
    assert.match(userInfo.description, /FEATURE_OAUTH_APPS_ENABLED/);
    assert.match(userInfo.responses["503"]!.description, /disabled/);
    assert.match(userInfo.responses["503"]!.description, /bearer-token/);
  }
  assert.match(
    paths["/.well-known/openid-configuration"]!.get!.description,
    /only issuer, jwks_uri, and the supported ES256 verification algorithm/,
  );
  assert.match(
    paths["/.well-known/jwks.json"]!.get!.description,
    /private JWK is never returned/,
  );
});

async function discoveryDocument(app: {
  fetch(request: Request): Promise<Response | null>;
}): Promise<Record<string, unknown>> {
  const response = await app.fetch(
    new Request(`${ISSUER}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(response?.status, 200);
  return (await response!.json()) as Record<string, unknown>;
}

function streamedUserInfoRequest(): { request: Request; pulls(): number } {
  let pullCount = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pullCount += 1;
        controller.enqueue(
          new TextEncoder().encode(
            "ui=1&csrf_token=must-not-be-read&auth_mode=token&access_token=must-not-be-read",
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
    },
    body,
    duplex: "half",
  };
  return {
    request: new Request(`${ISSUER}/userinfo`, init),
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
