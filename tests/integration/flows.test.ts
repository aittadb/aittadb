import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config";
import { createAuthBrokerWithStore } from "../../src/handler";
import { MemoryAuthStore } from "../../src/store/memory";
import { createClientRegistration, issueTokens } from "../../src/oauth";
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
  const browserRootHtml = await browserRoot!.text();
  assert.match(browserRootHtml, /<h1>Sites Auth Broker<\/h1>/);
  assert.match(browserRootHtml, /href="\/auth-ui\.css"/);
  assert.doesNotMatch(browserRootHtml, /<style>/);
  assert.match(browserRootHtml, /identity-graphic/);
  assert.match(
    browserRootHtml,
    /https:\/\/github\.com\/sendanor\/sites-auth-broker/,
  );
  assert.match(browserRootHtml, /sendanor\/sites-auth-broker on GitHub/);
  assert.match(browserRoot!.headers.get("content-type") ?? "", /^text\/html/);

  const browserCss = await app.fetch(
    new Request("https://broker.example.test/auth-ui.css", {
      headers: { accept: "text/css,*/*;q=0.1" },
    }),
  );
  assert.match(browserCss!.headers.get("content-type") ?? "", /^text\/css/);
  const browserCssText = await browserCss!.text();
  assert.match(browserCssText, /\.sab-shell/);
  assert.match(browserCssText, /\.repo-badge/);

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

  const browserHealth = await app.fetch(
    new Request("https://broker.example.test/health", {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }),
  );
  assert.match(await browserHealth!.text(), /<h1>Service health<\/h1>/);
  assert.match(browserHealth!.headers.get("content-type") ?? "", /^text\/html/);

  const apiMissing = await app.fetch(
    new Request("https://broker.example.test/missing", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(apiMissing?.status, 404);
  const apiMissingJson = (await apiMissing?.json()) as {
    error: string;
    _links: { docs: { href: string } };
    actions: { token: { method: string } };
  };
  assert.equal(apiMissingJson.error, "not_found");
  assert.equal(apiMissingJson._links.docs.href, "/docs");
  assert.equal(apiMissingJson.actions.token.method, "POST");

  const browserMissing = await app.fetch(
    new Request("https://broker.example.test/missing", {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }),
  );
  const browserMissingHtml = await browserMissing!.text();
  assert.equal(browserMissing?.status, 404);
  assert.match(browserMissingHtml, /<h1>Not found<\/h1>/);
  assert.match(browserMissingHtml, /class="sab-shell/);
  assert.match(browserMissingHtml, /identity-graphic/);

  const forbiddenAdmin = await app.fetch(
    new Request("https://broker.example.test/admin/clients", {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }),
  );
  assert.equal(forbiddenAdmin?.status, 403);
  assert.match(await forbiddenAdmin!.text(), /<h1>Forbidden<\/h1>/);
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
    _links: { verification: { href: string } };
    actions: { poll: { method: string } };
  };
  assert.equal(
    deviceJson._links.verification.href,
    "https://broker.example.test/device",
  );
  assert.equal(deviceJson.actions.poll.method, "POST");

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
  const pendingJson = (await pending?.json()) as {
    error: string;
    _links: { docs: { href: string } };
    actions: { token: { method: string } };
  };
  assert.equal(pendingJson.error, "authorization_pending");
  assert.equal(pendingJson._links.docs.href, "/docs");
  assert.equal(pendingJson.actions.token.method, "POST");

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

test("broker storage API stores D1 records and R2 files for the local user and client", async () => {
  const env = await testEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const app = createAuthBrokerWithStore(env, store);
  const now = nowSeconds();
  const user = await store.findOrCreateUser(
    {
      email: "user@example.test",
      fullName: "Test User",
      displayName: "Test User",
    },
    now,
  );
  const { client } = await createClientRegistration(
    {
      type: "public",
      name: "Storage App",
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["storage.read", "storage.write", "storage.delete"],
      origins: ["https://client.example.test"],
    },
    store,
    now,
  );
  const tokenSet = await issueTokens({
    config,
    store,
    user,
    client,
    scope: "storage.read storage.write storage.delete",
    includeRefresh: false,
    now,
  });
  const accessToken = String(tokenSet.access_token);

  const recordPut = await app.fetch(
    new Request("https://broker.example.test/storage/records/app/settings", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ theme: "midnight", count: 1 }),
    }),
  );
  assert.equal(recordPut?.status, 200);
  const recordPutJson = (await recordPut?.json()) as {
    key: string;
    value: { theme: string; count: number };
    _links: { self: { href: string } };
    actions: { replace: { method: string } };
  };
  assert.equal(recordPutJson.key, "app/settings");
  assert.equal(recordPutJson.value.theme, "midnight");
  assert.equal(recordPutJson._links.self.href, "/storage/records/app/settings");
  assert.equal(recordPutJson.actions.replace.method, "PUT");

  const recordList = await app.fetch(
    new Request("https://broker.example.test/storage/records", {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  );
  const recordListJson = (await recordList?.json()) as {
    records: Array<{ key: string }>;
    actions: { put: { href: string } };
  };
  assert.deepEqual(
    recordListJson.records.map((record) => record.key),
    ["app/settings"],
  );
  assert.equal(
    recordListJson.actions.put.href,
    "https://broker.example.test/storage/records/{key}",
  );

  const { client: writeOnlyClient } = await createClientRegistration(
    {
      type: "public",
      name: "Write Only",
      redirectUris: ["https://write.example.test/callback"],
      scopes: ["storage.write"],
      origins: [],
    },
    store,
    now,
  );
  const writeOnlyTokens = await issueTokens({
    config,
    store,
    user,
    client: writeOnlyClient,
    scope: "storage.write",
    includeRefresh: false,
    now,
  });
  const missingScope = await app.fetch(
    new Request("https://broker.example.test/storage/records/app/settings", {
      headers: {
        authorization: `Bearer ${String(writeOnlyTokens.access_token)}`,
      },
    }),
  );
  assert.equal(missingScope?.status, 403);
  assert.equal(
    ((await missingScope?.json()) as { error: string }).error,
    "insufficient_scope",
  );

  const filePut = await app.fetch(
    new Request("https://broker.example.test/storage/files/notes/hello.txt", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "text/plain",
      },
      body: "hello storage",
    }),
  );
  assert.equal(filePut?.status, 200);
  const filePutJson = (await filePut?.json()) as {
    key: string;
    content_type: string;
    size: number;
    sha256: string;
  };
  assert.equal(filePutJson.key, "notes/hello.txt");
  assert.equal(filePutJson.content_type, "text/plain");
  assert.equal(filePutJson.size, 13);
  assert.ok(filePutJson.sha256);

  const fileGet = await app.fetch(
    new Request("https://broker.example.test/storage/files/notes/hello.txt", {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  );
  assert.equal(fileGet?.status, 200);
  assert.equal(fileGet?.headers.get("content-type"), "text/plain");
  assert.equal(await fileGet?.text(), "hello storage");

  const fileList = await app.fetch(
    new Request("https://broker.example.test/storage/files", {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  );
  assert.deepEqual(
    ((await fileList?.json()) as { files: Array<{ key: string }> }).files.map(
      (file) => file.key,
    ),
    ["notes/hello.txt"],
  );

  const deleteRecord = await app.fetch(
    new Request("https://broker.example.test/storage/records/app/settings", {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  );
  assert.equal(
    ((await deleteRecord?.json()) as { deleted: boolean }).deleted,
    true,
  );

  const deleteFile = await app.fetch(
    new Request("https://broker.example.test/storage/files/notes/hello.txt", {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  );
  assert.equal(
    ((await deleteFile?.json()) as { deleted: boolean }).deleted,
    true,
  );

  const missingFile = await app.fetch(
    new Request("https://broker.example.test/storage/files/notes/hello.txt", {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  );
  assert.equal(missingFile?.status, 404);
});
