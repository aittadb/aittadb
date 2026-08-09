import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { nowSeconds, sha256 } from "../../src/crypto";
import { createClientRegistration, verifyAccessToken } from "../../src/oauth";
import { MemoryAuthStore } from "../../src/store/memory";
import type { AittaDBApp } from "../../src/handler";
import { createTestAittaDB, form, testEnv } from "../helpers";

const ISSUER = "https://aittadb.example.test";

test("service clients renew short-lived tokens for one isolated storage namespace", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" });
  const config = loadConfig(env, ISSUER);
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);
  const serviceA = await registerService(store, "Service A");
  const serviceB = await registerService(store, "Service B");

  assert.equal(await store.countUsers(), 0);
  assert.equal(store.users.size, 0);
  assert.equal(await store.hasServicePrincipal(serviceA.client.id), true);
  assert.equal(
    await store.getClientSecretHash(serviceA.client.id),
    await sha256(serviceA.secret!),
  );
  assert.notEqual(
    await store.getClientSecretHash(serviceA.client.id),
    serviceA.secret,
  );

  const first = await token(app, serviceA.client.id, serviceA.secret!);
  const second = await token(app, serviceA.client.id, serviceA.secret!);
  const serviceBToken = await token(app, serviceB.client.id, serviceB.secret!);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstBody = await tokenBody(first);
  const secondBody = await tokenBody(second);
  const serviceBBody = await tokenBody(serviceBToken);
  assert.notEqual(firstBody.access_token, secondBody.access_token);
  assert.equal(firstBody.expires_in, 600);
  assert.equal(firstBody.scope, "storage.read storage.write storage.delete");
  for (const forbidden of ["refresh_token", "id_token", "email", "name"]) {
    assert.equal(Object.hasOwn(firstBody, forbidden), false);
  }

  const verified = await verifyAccessToken(
    firstBody.access_token,
    config,
    store,
    serviceA.client.id,
  );
  assert.equal(verified.claims.sub, serviceA.client.id);
  assert.equal(verified.claims.aud, serviceA.client.id);
  assert.equal(verified.claims.subject_type, "service");
  assert.equal(verified.claims.client_id, serviceA.client.id);
  assert.equal(Object.hasOwn(verified.claims, "email"), false);
  assert.equal(Object.hasOwn(verified.claims, "name"), false);

  assert.equal(
    (
      await storage(app, firstBody.access_token, "/storage/records/shared", {
        method: "PUT",
        body: JSON.stringify({ owner: "service-a" }),
      })
    ).status,
    200,
  );
  assert.equal(
    (await storage(app, serviceBBody.access_token, "/storage/records/shared"))
      .status,
    404,
  );
  assert.equal(
    (
      await storage(app, serviceBBody.access_token, "/storage/records/shared", {
        method: "PUT",
        body: JSON.stringify({ owner: "service-b" }),
      })
    ).status,
    200,
  );
  const renewedRead = await storage(
    app,
    secondBody.access_token,
    "/storage/records/shared",
  );
  assert.equal(renewedRead.status, 200);
  assert.equal(
    (
      (await renewedRead.json()) as {
        data: { value: { owner: string } };
      }
    ).data.value.owner,
    "service-a",
  );

  const crossClientRevoke = await revoke(
    app,
    serviceB.client.id,
    serviceB.secret!,
    firstBody.access_token,
  );
  assert.equal(crossClientRevoke.status, 200);
  assert.equal(
    (await storage(app, firstBody.access_token, "/storage/records/shared"))
      .status,
    200,
  );

  assert.equal(
    (
      await revoke(
        app,
        serviceA.client.id,
        serviceA.secret!,
        firstBody.access_token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await storage(app, firstBody.access_token, "/storage/records/shared"))
      .status,
    401,
  );
  assert.equal(
    (await storage(app, secondBody.access_token, "/storage/records/shared"))
      .status,
    200,
  );

  const inactive = await introspect(
    app,
    serviceA.client.id,
    serviceA.secret!,
    firstBody.access_token,
  );
  assert.deepEqual(await inactive.json(), { active: false });
  const active = (await (
    await introspect(
      app,
      serviceA.client.id,
      serviceA.secret!,
      secondBody.access_token,
    )
  ).json()) as Record<string, unknown>;
  assert.equal(active.active, true);
  assert.equal(active.subject_type, "service");
  assert.equal(active.sub, serviceA.client.id);

  const userInfo = await app.fetch(
    new Request(`${ISSUER}/userinfo`, {
      headers: { authorization: `Bearer ${secondBody.access_token}` },
    }),
  );
  assert.equal(userInfo?.status, 401);

  await store.setClientDisabled(serviceA.client.id, nowSeconds());
  assert.equal(
    (await token(app, serviceA.client.id, serviceA.secret!)).status,
    401,
  );
  assert.equal(
    (await storage(app, secondBody.access_token, "/storage/records/shared"))
      .status,
    401,
  );
});

test("service-client registration and grant boundaries fail closed", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" });
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);
  const service = await createClientRegistration(
    {
      type: "service",
      name: "Read service",
      redirectUris: [],
      scopes: ["storage.read"],
      origins: [],
    },
    store,
    nowSeconds(),
  );

  for (const invalid of [
    {
      type: "service" as const,
      name: "Identity service",
      redirectUris: [],
      scopes: ["openid"],
      origins: [],
    },
    {
      type: "service" as const,
      name: "Redirecting service",
      redirectUris: ["https://service.example.test/callback"],
      scopes: ["storage.read"],
      origins: [],
    },
    {
      type: "service" as const,
      name: "Browser service",
      redirectUris: [],
      scopes: ["storage.read"],
      origins: ["https://service.example.test"],
    },
  ]) {
    await assert.rejects(
      createClientRegistration(invalid, store, nowSeconds()),
    );
  }

  assert.equal(
    (await token(app, service.client.id, "wrong-secret")).status,
    401,
  );
  const tooBroad = await token(
    app,
    service.client.id,
    service.secret!,
    "storage.read storage.write",
  );
  assert.equal(tooBroad.status, 400);
  assert.equal((await oauthBody(tooBroad)).error, "invalid_scope");

  const foreign = await token(
    app,
    service.client.id,
    service.secret!,
    undefined,
    { origin: "https://foreign.example.test" },
  );
  assert.equal(foreign.status, 403);

  const device = await app.fetch(
    new Request(`${ISSUER}/oauth/device_authorization`, {
      method: "POST",
      headers: {
        authorization: basic(service.client.id, service.secret!),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ client_id: service.client.id, scope: "storage.read" }),
    }),
  );
  assert.equal(device?.status, 400);
  assert.equal((await oauthBody(device!)).error, "unauthorized_client");

  const authorize = await app.fetch(
    new Request(
      `${ISSUER}/authorize?client_id=${service.client.id}&redirect_uri=${encodeURIComponent("https://service.example.test/callback")}&response_type=code&scope=storage.read&code_challenge=${"a".repeat(43)}&code_challenge_method=S256`,
      { headers: { accept: "application/json" } },
    ),
  );
  assert.equal(authorize?.status, 400);
  assert.equal((await oauthBody(authorize!)).error, "invalid_client");

  const refresh = await grant(app, service.client.id, service.secret!, {
    grant_type: "refresh_token",
    refresh_token: "not-a-refresh-token",
  });
  assert.equal(refresh.status, 400);
  assert.equal((await oauthBody(refresh)).error, "unauthorized_client");

  const publicClient = await createClientRegistration(
    {
      type: "public",
      name: "Public client",
      redirectUris: ["https://public.example.test/callback"],
      scopes: ["storage.read"],
      origins: [],
    },
    store,
    nowSeconds(),
  );
  const publicGrant = await grant(app, publicClient.client.id, null, {
    grant_type: "client_credentials",
  });
  assert.equal(publicGrant.status, 400);
  assert.equal((await oauthBody(publicGrant)).error, "unauthorized_client");

  const confidential = await createClientRegistration(
    {
      type: "confidential",
      name: "Interactive confidential",
      redirectUris: ["https://confidential.example.test/callback"],
      scopes: ["storage.read"],
      origins: [],
    },
    store,
    nowSeconds(),
  );
  const confidentialGrant = await grant(
    app,
    confidential.client.id,
    confidential.secret!,
    { grant_type: "client_credentials" },
  );
  assert.equal(confidentialGrant.status, 400);
  assert.equal(
    (await oauthBody(confidentialGrant)).error,
    "unauthorized_client",
  );
});

async function registerService(store: MemoryAuthStore, name: string) {
  return createClientRegistration(
    {
      type: "service",
      name,
      redirectUris: [],
      scopes: ["storage.read", "storage.write", "storage.delete"],
      origins: [],
    },
    store,
    nowSeconds(),
  );
}

function token(
  app: AittaDBApp,
  clientId: string,
  secret: string,
  scope?: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return grant(
    app,
    clientId,
    secret,
    {
      grant_type: "client_credentials",
      ...(scope === undefined ? {} : { scope }),
    },
    headers,
  );
}

async function grant(
  app: AittaDBApp,
  clientId: string,
  secret: string | null,
  body: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const response = await app.fetch(
    new Request(`${ISSUER}/oauth/token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        ...(secret ? { authorization: basic(clientId, secret) } : {}),
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: form({ ...body, ...(!secret ? { client_id: clientId } : {}) }),
    }),
  );
  assert.ok(response);
  return response;
}

async function storage(
  app: AittaDBApp,
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await app.fetch(
    new Request(`${ISSUER}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
    }),
  );
  assert.ok(response);
  return response;
}

async function revoke(
  app: AittaDBApp,
  clientId: string,
  secret: string,
  accessToken: string,
): Promise<Response> {
  const response = await app.fetch(
    new Request(`${ISSUER}/oauth/revoke`, {
      method: "POST",
      headers: {
        authorization: basic(clientId, secret),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ token: accessToken, token_type_hint: "access_token" }),
    }),
  );
  assert.ok(response);
  return response;
}

async function introspect(
  app: AittaDBApp,
  clientId: string,
  secret: string,
  accessToken: string,
): Promise<Response> {
  const response = await app.fetch(
    new Request(`${ISSUER}/oauth/introspect`, {
      method: "POST",
      headers: {
        authorization: basic(clientId, secret),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ token: accessToken, token_type_hint: "access_token" }),
    }),
  );
  assert.ok(response);
  return response;
}

function basic(clientId: string, secret: string): string {
  return `Basic ${btoa(`${clientId}:${secret}`)}`;
}

async function tokenBody(response: Response): Promise<{
  access_token: string;
  expires_in: number;
  scope: string;
}> {
  return (await response.json()) as {
    access_token: string;
    expires_in: number;
    scope: string;
  };
}

async function oauthBody(response: Response): Promise<{ error: string }> {
  return (await response.json()) as { error: string };
}
