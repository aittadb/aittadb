import test from "node:test";
import assert from "node:assert/strict";
import { createAuthBrokerWithStore } from "../../src/handler";
import { MemoryAuthStore } from "../../src/store/memory";
import { createClientRegistration } from "../../src/oauth";
import { nowSeconds, sha256 } from "../../src/crypto";
import { cookieValue, form, testEnv } from "../helpers";

test("metadata routes negotiate HTML for browsers and JSON for API clients", async () => {
  const env = await testEnv();
  const app = createAuthBrokerWithStore(env, new MemoryAuthStore());

  const apiRoot = await app.fetch(
    new Request("https://broker.example.test/", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(
    apiRoot?.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  const apiRootJson = (await apiRoot?.json()) as {
    service: string;
    _links: { docs: { href: string }; oidcConfiguration: { href: string } };
    actions: { deviceAuthorization: { method: string } };
  };
  assert.equal(apiRootJson.service, "Sites Auth Broker");
  assert.equal(
    apiRootJson._links.docs.href,
    "https://broker.example.test/docs",
  );
  assert.equal(
    apiRootJson._links.oidcConfiguration.href,
    "https://broker.example.test/.well-known/openid-configuration",
  );
  assert.equal(apiRootJson.actions.deviceAuthorization.method, "POST");

  const browserRoot = await app.fetch(
    new Request("https://broker.example.test/", {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }),
  );
  assert.match(await browserRoot!.text(), /<h1>Sites Auth Broker<\/h1>/);
  assert.match(browserRoot!.headers.get("content-type") ?? "", /^text\/html/);

  const cliHealth = await app.fetch(
    new Request("https://broker.example.test/health", {
      headers: { accept: "*/*" },
    }),
  );
  const cliHealthJson = (await cliHealth?.json()) as {
    ok: boolean;
    _links: { service: { href: string } };
  };
  assert.equal(cliHealthJson.ok, true);
  assert.equal(
    cliHealthJson._links.service.href,
    "https://broker.example.test",
  );
});

test("device flow succeeds with local UUID subject, ID token, refresh token, UserInfo, introspection, and revocation", async () => {
  const env = await testEnv({ DEVICE_POLL_INTERVAL_SECONDS: "1" });
  const store = new MemoryAuthStore();
  const app = createAuthBrokerWithStore(env, store);
  const { client } = await createClientRegistration(
    {
      type: "public",
      name: "CLI",
      redirectUris: ["http://127.0.0.1/callback"],
      scopes: ["openid", "email", "profile", "offline_access"],
      origins: [],
    },
    store,
    nowSeconds(),
  );

  const device = await app.fetch(
    new Request("https://broker.example.test/oauth/device_authorization", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: client.id,
        scope: "openid email profile offline_access",
      }),
    }),
  );
  assert.equal(device?.status, 200);
  const deviceJson = (await device?.json()) as {
    device_code: string;
    user_code: string;
  };

  const pending = await app.fetch(
    new Request("https://broker.example.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceJson.device_code,
        client_id: client.id,
      }),
    }),
  );
  assert.equal(
    ((await pending?.json()) as { error: string }).error,
    "authorization_pending",
  );

  const entry = await app.fetch(
    new Request(
      `https://broker.example.test/device?user_code=${deviceJson.user_code}`,
    ),
  );
  const csrf = cookieValue(entry!, "sab_csrf");
  const continueResponse = await app.fetch(
    new Request("https://broker.example.test/device", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `sab_csrf=${csrf}`,
        origin: "https://broker.example.test",
      },
      body: form({ csrf_token: csrf, user_code: deviceJson.user_code }),
    }),
  );
  const decisionCsrf = cookieValue(continueResponse!, "sab_csrf");
  const approved = await app.fetch(
    new Request("https://broker.example.test/device/decision", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `sab_csrf=${decisionCsrf}`,
        origin: "https://broker.example.test",
      },
      body: form({
        csrf_token: decisionCsrf,
        user_code: deviceJson.user_code,
        decision: "approve",
      }),
    }),
  );
  assert.equal(approved?.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const token = await app.fetch(
    new Request("https://broker.example.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceJson.device_code,
        client_id: client.id,
      }),
    }),
  );
  const tokenJson = (await token?.json()) as {
    access_token: string;
    id_token: string;
    refresh_token: string;
  };
  assert.ok(tokenJson.access_token);
  assert.ok(tokenJson.id_token);
  assert.ok(tokenJson.refresh_token);
  assert.notEqual(tokenJson.access_token.includes("user@example.test"), true);

  const userinfo = await app.fetch(
    new Request("https://broker.example.test/userinfo", {
      headers: { authorization: `Bearer ${tokenJson.access_token}` },
    }),
  );
  const userinfoJson = (await userinfo?.json()) as {
    sub: string;
    email: string;
    name: string;
  };
  assert.equal(userinfoJson.email, "user@example.test");
  assert.match(userinfoJson.sub, /^[0-9a-f-]{36}$/);

  const { client: confidential, secret } = await createClientRegistration(
    {
      type: "confidential",
      name: "API",
      redirectUris: ["https://api.example.test/callback"],
      scopes: ["openid", "email", "profile"],
      origins: [],
    },
    store,
    nowSeconds(),
  );
  const introspection = await app.fetch(
    new Request("https://broker.example.test/oauth/introspect", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${confidential.id}:${secret}`)}`,
      },
      body: form({ token: tokenJson.access_token }),
    }),
  );
  assert.equal(
    ((await introspection?.json()) as { active: boolean }).active,
    false,
  );

  const refreshed = await app.fetch(
    new Request("https://broker.example.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        refresh_token: tokenJson.refresh_token,
        client_id: client.id,
      }),
    }),
  );
  assert.ok(
    ((await refreshed?.json()) as { refresh_token: string }).refresh_token,
  );

  const reuse = await app.fetch(
    new Request("https://broker.example.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        refresh_token: tokenJson.refresh_token,
        client_id: client.id,
      }),
    }),
  );
  assert.equal(
    ((await reuse?.json()) as { error: string }).error,
    "invalid_grant",
  );
});

test("authorization code with PKCE enforces exact redirect URI and one-time code use", async () => {
  const env = await testEnv();
  const store = new MemoryAuthStore();
  const app = createAuthBrokerWithStore(env, store);
  const verifier =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
  const { client } = await createClientRegistration(
    {
      type: "public",
      name: "Browser",
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["openid", "email", "profile"],
      origins: ["https://client.example.test"],
    },
    store,
    nowSeconds(),
  );

  const bad = await app.fetch(
    new Request(
      `https://broker.example.test/authorize?response_type=code&client_id=${client.id}&redirect_uri=${encodeURIComponent("https://client.example.test/other")}&scope=openid&state=s&code_challenge=${await sha256(verifier)}&code_challenge_method=S256`,
    ),
  );
  assert.equal(bad?.status, 400);

  const authorize = await app.fetch(
    new Request(
      `https://broker.example.test/authorize?response_type=code&client_id=${client.id}&redirect_uri=${encodeURIComponent("https://client.example.test/callback")}&scope=openid%20email%20profile&state=s&nonce=n&code_challenge=${await sha256(verifier)}&code_challenge_method=S256`,
    ),
  );
  assert.equal(authorize?.status, 302);
  const consentLocation = authorize?.headers.get("location") ?? "";
  const consent = await app.fetch(new Request(consentLocation));
  const csrf = cookieValue(consent!, "sab_csrf");
  const requestId =
    new URL(consentLocation).searchParams.get("request_id") ?? "";
  const approved = await app.fetch(
    new Request("https://broker.example.test/consent", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `sab_csrf=${csrf}`,
        origin: "https://broker.example.test",
      },
      body: form({
        csrf_token: csrf,
        request_id: requestId,
        decision: "approve",
      }),
    }),
  );
  const callback = new URL(approved?.headers.get("location") ?? "");
  assert.equal(callback.searchParams.get("state"), "s");
  const code = callback.searchParams.get("code") ?? "";
  const token = await app.fetch(
    new Request("https://broker.example.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        client_id: client.id,
        code,
        redirect_uri: "https://client.example.test/callback",
        code_verifier: verifier,
      }),
    }),
  );
  assert.ok(((await token?.json()) as { access_token: string }).access_token);

  const secondUse = await app.fetch(
    new Request("https://broker.example.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        client_id: client.id,
        code,
        redirect_uri: "https://client.example.test/callback",
        code_verifier: verifier,
      }),
    }),
  );
  assert.equal(
    ((await secondUse?.json()) as { error: string }).error,
    "invalid_grant",
  );
});
