import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { nowSeconds, sha256, uuid } from "../../src/crypto";
import {
  approveAuthorizationRequest,
  createClientRegistration,
  issueTokens,
  verifyAccessToken,
} from "../../src/oauth";
import { MemoryAuthStore } from "../../src/store/memory";
import type {
  AuthorizationRequest,
  DeviceGrant,
  RefreshTokenFamily,
  RefreshTokenRecord,
} from "../../src/types";
import { cookieValue, createTestAittaDB, form, testEnv } from "../helpers";

test("authorization requests and one-time credentials have one concurrent winner", async () => {
  const store = new MemoryAuthStore();
  const now = nowSeconds();
  const user = await store.findOrCreateUser(
    {
      email: "atomic@example.test",
      fullName: "Atomic User",
      displayName: "Atomic User",
    },
    now,
  );
  const { client } = await createClientRegistration(
    {
      type: "public",
      name: "Atomic Client",
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["openid"],
      origins: [],
    },
    store,
    now,
  );
  const authorizationRequest: AuthorizationRequest = {
    id: uuid(),
    clientId: client.id,
    redirectUri: client.redirectUris[0],
    scope: "openid",
    state: "state",
    nonce: null,
    codeChallenge: "A".repeat(43),
    createdAt: now,
    expiresAt: now + 300,
    userId: null,
    status: "pending",
  };
  await store.createAuthorizationRequest(authorizationRequest);

  const approvals = await Promise.all([
    approveAuthorizationRequest(authorizationRequest, user, store, now),
    approveAuthorizationRequest(authorizationRequest, user, store, now),
  ]);
  assert.equal(approvals.filter(Boolean).length, 1);
  assert.equal(store.authCodes.size, 1);

  const storedCode = [...store.authCodes.values()][0];
  assert.ok(storedCode);
  const codeResults = await Promise.all([
    store.consumeAuthorizationCode(
      storedCode.codeHash,
      client.id,
      client.redirectUris[0],
      now,
    ),
    store.consumeAuthorizationCode(
      storedCode.codeHash,
      client.id,
      client.redirectUris[0],
      now,
    ),
  ]);
  assert.equal(codeResults.filter(Boolean).length, 1);

  const grant: DeviceGrant = {
    id: uuid(),
    deviceCodeHash: await sha256("device-code"),
    userCodeHash: await sha256("USERCODE"),
    userCodeDisplay: "USERCODE",
    clientId: client.id,
    scope: "openid",
    status: "pending",
    userId: null,
    createdAt: now,
    expiresAt: now + 300,
    intervalSeconds: 5,
    lastPollAt: null,
    slowDownCount: 0,
  };
  await store.createDeviceGrant(grant);
  const decisions = await Promise.all([
    store.transitionDeviceGrant(grant.userCodeHash, "approved", user.id, now),
    store.transitionDeviceGrant(grant.userCodeHash, "approved", user.id, now),
  ]);
  assert.equal(decisions.filter(Boolean).length, 1);
  const deviceResults = await Promise.all([
    store.consumeDeviceGrant(grant.deviceCodeHash, client.id, now),
    store.consumeDeviceGrant(grant.deviceCodeHash, client.id, now),
  ]);
  assert.equal(deviceResults.filter(Boolean).length, 1);

  const family: RefreshTokenFamily = {
    id: uuid(),
    userId: user.id,
    clientId: client.id,
    status: "active",
    createdAt: now,
  };
  const refresh: RefreshTokenRecord = {
    id: uuid(),
    familyId: family.id,
    tokenHash: await sha256("refresh-token"),
    userId: user.id,
    clientId: client.id,
    scope: "openid offline_access",
    expiresAt: now + 300,
    usedAt: null,
    revokedAt: null,
  };
  await store.createRefreshFamily(family);
  await store.createRefreshToken(refresh);
  const refreshResults = await Promise.all([
    store.consumeRefreshToken(refresh.tokenHash, client.id, now),
    store.consumeRefreshToken(refresh.tokenHash, client.id, now),
  ]);
  assert.equal(refreshResults.filter(Boolean).length, 1);
  assert.equal(store.families.get(family.id)?.status, "revoked");
});

test("consent approval and denial cannot be replayed through HTTP", async () => {
  const env = await testEnv();
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);
  const { client } = await createClientRegistration(
    {
      type: "public",
      name: "Consent Replay Client",
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["openid"],
      origins: [],
    },
    store,
    nowSeconds(),
  );

  // Denial does not remember consent; approval does. This order exercises both
  // terminal paths without the second request taking the valid consent shortcut.
  for (const decision of ["deny", "approve"] as const) {
    const verifier = `${decision}-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQR`;
    const authorize = await app.fetch(
      new Request(
        `https://aittadb.example.test/authorize?response_type=code&client_id=${client.id}&redirect_uri=${encodeURIComponent(client.redirectUris[0])}&scope=openid&state=${decision}&code_challenge=${await sha256(verifier)}&code_challenge_method=S256`,
      ),
    );
    const consentUrl = authorize?.headers.get("location") ?? "";
    const consent = await app.fetch(
      new Request(consentUrl, { headers: { accept: "text/html" } }),
    );
    const csrf = cookieValue(consent!, "aittadb_csrf");
    const submit = () =>
      app.fetch(
        new Request("https://aittadb.example.test/consent", {
          method: "POST",
          headers: {
            accept: "text/html",
            "content-type": "application/x-www-form-urlencoded",
            cookie: `aittadb_csrf=${csrf}`,
            origin: "https://aittadb.example.test",
          },
          body: form({
            csrf_token: csrf,
            request_id: new URL(consentUrl).searchParams.get("request_id")!,
            decision,
          }),
        }),
      );
    assert.equal((await submit())?.status, 302);
    const replay = await submit();
    await assertSafeTerminalLoser(replay, [client.redirectUris[0], decision]);
  }
  assert.equal(store.authCodes.size, 1);
});

test("remembered-consent GET has one redirect winner under concurrent and sequential replay", async () => {
  const env = await testEnv();
  const store = new MemoryAuthStore();
  const identity = {
    email: "remembered@example.test",
    fullName: "Remembered User",
    displayName: "Remembered User",
  };
  const app = createTestAittaDB(env, store, identity);
  const now = nowSeconds();
  const user = await store.findOrCreateUser(identity, now);
  const { client } = await createClientRegistration(
    {
      type: "public",
      name: "Remembered Consent Client",
      redirectUris: ["https://client.example.test/remembered-callback"],
      scopes: ["openid"],
      origins: [],
    },
    store,
    now,
  );
  await store.saveConsent(user.id, client.id, "openid");

  const state = "remembered-consent-state";
  const authorize = await app.fetch(
    new Request(
      `https://aittadb.example.test/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client.id,
        redirect_uri: client.redirectUris[0],
        scope: "openid",
        state,
        code_challenge: await sha256(
          "remembered-consent-verifier-value-with-43-characters",
        ),
        code_challenge_method: "S256",
      })}`,
    ),
  );
  assert.equal(authorize?.status, 302);
  const consentUrl = authorize?.headers.get("location") ?? "";

  const attempts = await Promise.all([
    app.fetch(new Request(consentUrl, { headers: { accept: "text/html" } })),
    app.fetch(new Request(consentUrl, { headers: { accept: "text/html" } })),
  ]);
  const winner = attempts.find((response) => response?.status === 302);
  const loser = attempts.find((response) => response?.status === 400);
  assert.ok(winner);
  assert.ok(loser);
  const winnerLocation = new URL(winner.headers.get("location") ?? "");
  assert.equal(winnerLocation.origin, "https://client.example.test");
  assert.equal(winnerLocation.pathname, "/remembered-callback");
  assert.ok(winnerLocation.searchParams.get("code"));
  assert.equal(winnerLocation.searchParams.get("state"), state);
  await assertSafeTerminalLoser(loser, [client.redirectUris[0], state]);
  assert.equal(store.authCodes.size, 1);

  const sequentialReplay = await app.fetch(
    new Request(consentUrl, { headers: { accept: "application/json" } }),
  );
  await assertSafeTerminalLoser(sequentialReplay, [
    client.redirectUris[0],
    state,
  ]);
});

test("concurrent explicit approval and denial have one redirect winner", async () => {
  const env = await testEnv();
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);
  const { client } = await createClientRegistration(
    {
      type: "public",
      name: "Concurrent Decision Client",
      redirectUris: ["https://client.example.test/decision-callback"],
      scopes: ["openid"],
      origins: [],
    },
    store,
    nowSeconds(),
  );
  const state = "concurrent-decision-state";
  const authorize = await app.fetch(
    new Request(
      `https://aittadb.example.test/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client.id,
        redirect_uri: client.redirectUris[0],
        scope: "openid",
        state,
        code_challenge: await sha256(
          "concurrent-decision-verifier-value-with-43-characters",
        ),
        code_challenge_method: "S256",
      })}`,
    ),
  );
  const consentUrl = authorize?.headers.get("location") ?? "";
  const consent = await app.fetch(
    new Request(consentUrl, { headers: { accept: "text/html" } }),
  );
  const csrf = cookieValue(consent!, "aittadb_csrf");
  const requestId = new URL(consentUrl).searchParams.get("request_id") ?? "";
  const submit = (decision: "approve" | "deny") =>
    app.fetch(
      new Request("https://aittadb.example.test/consent", {
        method: "POST",
        headers: {
          accept: "text/html",
          "content-type": "application/x-www-form-urlencoded",
          cookie: `aittadb_csrf=${csrf}`,
          origin: "https://aittadb.example.test",
        },
        body: form({
          csrf_token: csrf,
          request_id: requestId,
          decision,
        }),
      }),
    );

  const attempts = await Promise.all([submit("approve"), submit("deny")]);
  const winners = attempts.filter((response) => response?.status === 302);
  const losers = attempts.filter((response) => response?.status === 400);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  const winnerLocation = new URL(winners[0]!.headers.get("location") ?? "");
  assert.equal(winnerLocation.origin, "https://client.example.test");
  assert.equal(winnerLocation.pathname, "/decision-callback");
  assert.equal(winnerLocation.searchParams.get("state"), state);
  assert.ok(
    winnerLocation.searchParams.has("code") ||
      winnerLocation.searchParams.get("error") === "access_denied",
  );
  await assertSafeTerminalLoser(losers[0], [client.redirectUris[0], state]);
  assert.ok(store.authCodes.size <= 1);

  await assertSafeTerminalLoser(await submit("approve"), [
    client.redirectUris[0],
    state,
  ]);
  await assertSafeTerminalLoser(await submit("deny"), [
    client.redirectUris[0],
    state,
  ]);
});

test("every browser mutation family rejects a missing Origin independently of CSRF", async () => {
  const baseEnv = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" });
  const store = new MemoryAuthStore();
  const adminIdentity = {
    email: "admin@example.test",
    fullName: "Admin User",
    displayName: "Admin User",
  };
  const adminUser = await store.findOrCreateUser(adminIdentity, nowSeconds());
  const env = { ...baseEnv, ADMIN_SUBJECTS: adminUser.id };
  const app = createTestAittaDB(env, store, adminIdentity);
  const { client } = await createClientRegistration(
    {
      type: "public",
      name: "Origin Client",
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["openid"],
      origins: [],
    },
    store,
    nowSeconds(),
  );
  const authRequest: AuthorizationRequest = {
    id: uuid(),
    clientId: client.id,
    redirectUri: client.redirectUris[0],
    scope: "openid",
    state: "origin-state",
    nonce: null,
    codeChallenge: await sha256(
      "origin-verifier-value-with-more-than-43-characters",
    ),
    createdAt: nowSeconds(),
    expiresAt: nowSeconds() + 300,
    userId: null,
    status: "pending",
  };
  await store.createAuthorizationRequest(authRequest);

  const cases = [
    {
      get: "/oauth/token",
      post: "/oauth/token",
      body: (csrf: string) =>
        form({ ui: "1", csrf_token: csrf, grant_type: "refresh_token" }),
    },
    {
      get: "/device",
      post: "/device",
      body: (csrf: string) =>
        form({ ui: "1", csrf_token: csrf, user_code: "ABCDEFGH" }),
    },
    {
      get: `/consent?request_id=${authRequest.id}`,
      post: "/consent",
      body: (csrf: string) =>
        form({
          csrf_token: csrf,
          request_id: authRequest.id,
          decision: "deny",
        }),
    },
    {
      get: "/admin/clients",
      post: "/admin/clients",
      body: (csrf: string) =>
        form({ csrf_token: csrf, name: "Missing Origin" }),
    },
    {
      get: "/storage/records",
      post: "/storage/records/origin-check",
      body: (csrf: string) =>
        form({
          ui: "1",
          csrf_token: csrf,
          auth_mode: "session",
          _method: "DELETE",
        }),
    },
  ];

  for (const fixture of cases) {
    const page = await app.fetch(
      new Request(`https://aittadb.example.test${fixture.get}`, {
        headers: { accept: "text/html" },
      }),
    );
    assert.equal(page?.status, 200, fixture.get);
    const csrf = cookieValue(page!, "aittadb_csrf");
    const response = await app.fetch(
      new Request(`https://aittadb.example.test${fixture.post}`, {
        method: "POST",
        headers: {
          accept: "text/html",
          "content-type": "application/x-www-form-urlencoded",
          cookie: `aittadb_csrf=${csrf}`,
        },
        body: fixture.body(csrf),
      }),
    );
    assert.equal(response?.status, 403, fixture.post);
    assert.match(await response!.text(), /same-origin/i, fixture.post);
  }
});

test("ID tokens cannot act as access tokens and UserInfo requires openid", async () => {
  const env = await testEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);
  const registration = await createClientRegistration(
    {
      type: "confidential",
      name: "Purpose Client",
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["openid", "email", "offline_access", "storage.read"],
      origins: [],
    },
    store,
    nowSeconds(),
  );
  const user = await store.findOrCreateUser(
    {
      email: "purpose@example.test",
      fullName: "Purpose User",
      displayName: "Purpose User",
    },
    nowSeconds(),
  );
  const tokens = await issueTokens({
    config,
    store,
    user,
    client: registration.client,
    scope: "openid email offline_access storage.read",
    includeRefresh: true,
    now: nowSeconds(),
  });
  const accessToken = String(tokens.access_token);
  const idToken = String(tokens.id_token);

  const idUserInfo = await bearerGet(app, "/userinfo", idToken);
  assert.equal(idUserInfo?.status, 401);
  const idStorage = await bearerGet(app, "/storage/records", idToken);
  assert.equal(idStorage?.status, 401);
  const idFileStorage = await bearerGet(app, "/storage/files", idToken);
  assert.equal(idFileStorage?.status, 401);
  await assert.rejects(
    verifyAccessToken(idToken, config, store, registration.client.id),
    /invalid_token_use/,
  );
  const idIntrospection = await introspect(
    app,
    registration.client.id,
    registration.secret!,
    idToken,
  );
  assert.deepEqual(await idIntrospection?.json(), { active: false });

  const accessIntrospection = await introspect(
    app,
    registration.client.id,
    registration.secret!,
    accessToken,
  );
  const accessIntrospectionJson = (await accessIntrospection?.json()) as {
    active: boolean;
    aud?: string;
    token_use?: string;
  };
  assert.equal(accessIntrospectionJson.active, true);
  assert.equal(accessIntrospectionJson.aud, registration.client.id);
  assert.equal(accessIntrospectionJson.token_use, "access");

  const refreshIntrospection = await introspect(
    app,
    registration.client.id,
    registration.secret!,
    String(tokens.refresh_token),
  );
  assert.deepEqual(await refreshIntrospection?.json(), { active: false });

  const nonOidc = await issueTokens({
    config,
    store,
    user,
    client: registration.client,
    scope: "email",
    includeRefresh: false,
    now: nowSeconds(),
  });
  assert.equal(
    (await bearerGet(app, "/userinfo", String(nonOidc.access_token)))?.status,
    401,
  );
  assert.equal((await bearerGet(app, "/userinfo", accessToken))?.status, 200);
});

test("revocation is client-bound and handles access tokens and refresh-token hint fallback", async () => {
  const env = await testEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);
  const owner = await createClientRegistration(
    {
      type: "confidential",
      name: "Token Owner",
      redirectUris: ["https://owner.example.test/callback"],
      scopes: ["openid", "offline_access"],
      origins: [],
    },
    store,
    nowSeconds(),
  );
  const other = await createClientRegistration(
    {
      type: "confidential",
      name: "Other Client",
      redirectUris: ["https://other.example.test/callback"],
      scopes: ["openid"],
      origins: [],
    },
    store,
    nowSeconds(),
  );
  const user = await store.findOrCreateUser(
    {
      email: "revoke@example.test",
      fullName: null,
      displayName: "revoke@example.test",
    },
    nowSeconds(),
  );
  const mint = () =>
    issueTokens({
      config,
      store,
      user,
      client: owner.client,
      scope: "openid offline_access",
      includeRefresh: true,
      now: nowSeconds(),
    });

  const first = await mint();
  await revoke(
    app,
    other.client.id,
    other.secret!,
    String(first.access_token),
    {
      hint: "access_token",
    },
  );
  assert.equal(
    (
      await introspect(
        app,
        owner.client.id,
        owner.secret!,
        String(first.access_token),
      )
    )?.status,
    200,
  );
  assert.equal(
    (
      (await (
        await introspect(
          app,
          owner.client.id,
          owner.secret!,
          String(first.access_token),
        )
      )?.json()) as { active: boolean }
    ).active,
    true,
  );

  await revoke(
    app,
    owner.client.id,
    owner.secret!,
    String(first.access_token),
    {
      hint: "access_token",
    },
  );
  assert.equal(
    (await bearerGet(app, "/userinfo", String(first.access_token)))?.status,
    401,
  );
  assert.equal(
    (
      (await (
        await introspect(
          app,
          owner.client.id,
          owner.secret!,
          String(first.access_token),
        )
      )?.json()) as { active: boolean }
    ).active,
    false,
  );

  const second = await mint();
  await revoke(
    app,
    owner.client.id,
    owner.secret!,
    String(second.refresh_token),
  );
  assert.equal(
    (await refresh(app, owner.client.id, owner.secret!, second.refresh_token))
      ?.status,
    400,
  );

  const third = await mint();
  await revoke(
    app,
    owner.client.id,
    owner.secret!,
    String(third.refresh_token),
    {
      hint: "access_token",
    },
  );
  assert.equal(
    (await refresh(app, owner.client.id, owner.secret!, third.refresh_token))
      ?.status,
    400,
  );
});

async function bearerGet(
  app: ReturnType<typeof createTestAittaDB>,
  path: string,
  token: string,
) {
  return app.fetch(
    new Request(`https://aittadb.example.test${path}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    }),
  );
}

async function assertSafeTerminalLoser(
  response: Response | null | undefined,
  forbiddenValues: readonly string[],
): Promise<void> {
  assert.ok(response);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("location"), null);
  const body = await response.text();
  assert.match(body, /invalid_request|no longer pending|expired/i);
  for (const value of forbiddenValues) {
    assert.equal(body.includes(value), false);
  }
}

async function introspect(
  app: ReturnType<typeof createTestAittaDB>,
  clientId: string,
  clientSecret: string,
  token: string,
) {
  return app.fetch(
    new Request("https://aittadb.example.test/oauth/introspect", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ client_id: clientId, client_secret: clientSecret, token }),
    }),
  );
}

async function revoke(
  app: ReturnType<typeof createTestAittaDB>,
  clientId: string,
  clientSecret: string,
  token: string,
  options: { hint?: string } = {},
) {
  const response = await app.fetch(
    new Request("https://aittadb.example.test/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: clientId,
        client_secret: clientSecret,
        token,
        ...(options.hint ? { token_type_hint: options.hint } : {}),
      }),
    }),
  );
  assert.equal(response?.status, 200);
}

async function refresh(
  app: ReturnType<typeof createTestAittaDB>,
  clientId: string,
  clientSecret: string,
  token: unknown,
) {
  return app.fetch(
    new Request("https://aittadb.example.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: String(token),
      }),
    }),
  );
}
