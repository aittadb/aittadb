import test from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { loadConfig } from "../../src/config";
import { createAittaDBWithStore } from "../../src/handler";
import { MemoryAuthStore } from "../../src/store/memory";
import { createClientRegistration, issueTokens } from "../../src/oauth";
import { nowSeconds, sha256 } from "../../src/crypto";
import { cookieValue, form, testEnv } from "../helpers";

test("metadata routes negotiate HTML for browsers and JSON for API clients", async () => {
  const env = await testEnv();
  const app = createAittaDBWithStore(env, new MemoryAuthStore());

  const apiRoot = await app.fetch(
    new Request("https://aittadb.example.test/", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(
    apiRoot?.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  const apiRootJson = (await apiRoot?.json()) as {
    service: string;
    upstreamSignIn: {
      source: string;
      identitySignal: string;
      stableSubjectSupplied: boolean;
      credentialsForwarded: boolean;
    };
    sessionIssuer: string;
    _links: { docs: { href: string }; oidcConfiguration: { href: string } };
    actions: { deviceAuthorization: { method: string } };
  };
  assert.equal(apiRootJson.service, "AittaDB");
  assert.equal(
    apiRootJson.upstreamSignIn.source,
    "ChatGPT sign-in inside ChatGPT Sites",
  );
  assert.equal(
    apiRootJson.upstreamSignIn.identitySignal,
    "server-side email and optional display name",
  );
  assert.equal(apiRootJson.upstreamSignIn.stableSubjectSupplied, false);
  assert.equal(apiRootJson.upstreamSignIn.credentialsForwarded, false);
  assert.equal(apiRootJson.sessionIssuer, "AittaDB");
  assert.equal(Object.hasOwn(apiRootJson, "tokenAuthority"), false);
  assert.equal(
    apiRootJson._links.docs.href,
    "https://aittadb.example.test/docs",
  );
  assert.equal(
    apiRootJson._links.oidcConfiguration.href,
    "https://aittadb.example.test/.well-known/openid-configuration",
  );
  assert.equal(apiRootJson.actions.deviceAuthorization.method, "POST");

  const browserRoot = await app.fetch(
    new Request("https://aittadb.example.test/", {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }),
  );
  const browserRootHtml = await browserRoot!.text();
  assert.match(browserRootHtml, /class="brand-heading" aria-label="AittaDB"/);
  assert.match(browserRootHtml, /class="brand-aitta">Aitta<\/span>/);
  assert.match(browserRootHtml, /class="brand-db">DB<\/span>/);
  assert.match(browserRootHtml, /href="\/auth-ui\.css"/);
  assert.doesNotMatch(browserRootHtml, /<style>/);
  assert.match(browserRootHtml, /class="aittadb-page"/);
  assert.match(browserRootHtml, /class="aittadb-shell/);
  assert.match(browserRootHtml, /class="visual-panel"/);
  assert.match(browserRootHtml, /src="\/aittadb-mark\.svg"/);
  assert.match(browserRootHtml, /src="\/aittadb-boundary\.jpg"/);
  assert.match(
    browserRootHtml,
    /property="og:image" content="https:\/\/aittadb\.example\.test\/og\.png"/,
  );
  assert.match(browserRootHtml, /name="twitter:card"/);
  assert.match(browserRootHtml, /ChatGPT sign-in/);
  assert.match(browserRootHtml, /separate local UUID/);
  assert.match(browserRootHtml, /tokens are not OpenAI or ChatGPT tokens/);
  assert.match(browserRootHtml, /Session issuer/);
  assert.doesNotMatch(browserRootHtml, /Token authority/i);
  assert.doesNotMatch(browserRootHtml, /Sites identity/);
  assert.doesNotMatch(browserRootHtml, /Sites Auth Broker/);
  assert.match(browserRootHtml, /https:\/\/github\.com\/aittadb\/aittadb/);
  assert.match(browserRootHtml, /View source on GitHub/);
  assert.match(browserRoot!.headers.get("content-type") ?? "", /^text\/html/);
  const contentSecurityPolicy =
    browserRoot!.headers.get("content-security-policy") ?? "";
  assert.match(contentSecurityPolicy, /font-src 'self'/);
  assert.match(contentSecurityPolicy, /img-src 'self'/);

  const browserCss = await app.fetch(
    new Request("https://aittadb.example.test/auth-ui.css", {
      headers: { accept: "text/css,*/*;q=0.1" },
    }),
  );
  assert.match(browserCss!.headers.get("content-type") ?? "", /^text\/css/);
  const browserCssText = await browserCss!.text();
  assert.match(browserCssText, /@font-face\{font-family:Inter/);
  assert.match(browserCssText, /\.aittadb-shell/);
  assert.match(browserCssText, /\.brand-wordmark/);
  assert.match(browserCssText, /font-weight:750/);
  assert.match(browserCssText, /#0b234a/);
  assert.match(browserCssText, /#f04a32/);
  assert.match(browserCssText, /#159ca6/);
  assert.match(browserCssText, /\.visual-image/);
  assert.match(browserCssText, /\.repo-link/);

  const [visualAsset, markAsset, fontAsset, socialAsset] = await Promise.all([
    stat(new URL("../../public/aittadb-boundary.jpg", import.meta.url)),
    stat(new URL("../../public/aittadb-mark.svg", import.meta.url)),
    stat(
      new URL(
        "../../public/fonts/inter-latin-wght-normal.woff2",
        import.meta.url,
      ),
    ),
    stat(new URL("../../public/og.png", import.meta.url)),
  ]);
  assert.ok(visualAsset.size > 100_000);
  assert.ok(markAsset.size > 500);
  assert.ok(fontAsset.size > 40_000);
  assert.ok(socialAsset.size > 100_000);
  const delegatedAsset = await app.fetch(
    new Request("https://aittadb.example.test/aittadb-boundary.jpg"),
  );
  assert.equal(delegatedAsset, null);

  const cliHealth = await app.fetch(
    new Request("https://aittadb.example.test/health", {
      headers: { accept: "*/*" },
    }),
  );
  const cliHealthJson = (await cliHealth?.json()) as {
    ok: boolean;
    service: string;
    _links: { service: { href: string } };
  };
  assert.equal(cliHealthJson.ok, true);
  assert.equal(cliHealthJson.service, "aittadb");
  assert.equal(
    cliHealthJson._links.service.href,
    "https://aittadb.example.test",
  );

  const browserHealth = await app.fetch(
    new Request("https://aittadb.example.test/health", {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }),
  );
  const browserHealthHtml = await browserHealth!.text();
  assert.match(browserHealthHtml, /<h1>Service health<\/h1>/);
  assert.match(browserHealthHtml, /Every service, accounted for/);
  assert.match(browserHealth!.headers.get("content-type") ?? "", /^text\/html/);

  const apiMissing = await app.fetch(
    new Request("https://aittadb.example.test/missing", {
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
    new Request("https://aittadb.example.test/missing", {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }),
  );
  const browserMissingHtml = await browserMissing!.text();
  assert.equal(browserMissing?.status, 404);
  assert.match(browserMissingHtml, /<h1>Not found<\/h1>/);
  assert.match(browserMissingHtml, /class="aittadb-shell/);
  assert.match(browserMissingHtml, /This request stopped here/);
  assert.match(browserMissingHtml, /src="\/aittadb-boundary\.jpg"/);

  const forbiddenAdmin = await app.fetch(
    new Request("https://aittadb.example.test/admin/clients", {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }),
  );
  assert.equal(forbiddenAdmin?.status, 403);
  const forbiddenAdminHtml = await forbiddenAdmin!.text();
  assert.match(forbiddenAdminHtml, /<h1>Forbidden<\/h1>/);
  assert.match(forbiddenAdminHtml, /Access stops at the boundary/);
});

test("device flow succeeds with local UUID subject, ID token, refresh token, UserInfo, introspection, and revocation", async () => {
  const env = await testEnv({ DEVICE_POLL_INTERVAL_SECONDS: "1" });
  const store = new MemoryAuthStore();
  const app = createAittaDBWithStore(env, store);
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
    new Request("https://aittadb.example.test/oauth/device_authorization", {
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
    "https://aittadb.example.test/device",
  );
  assert.equal(deviceJson.actions.poll.method, "POST");

  const pending = await app.fetch(
    new Request("https://aittadb.example.test/oauth/token", {
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
      `https://aittadb.example.test/device?user_code=${deviceJson.user_code}`,
    ),
  );
  assert.match(await entry!.text(), /A short code connects two moments/);
  const csrf = cookieValue(entry!, "aittadb_csrf");
  const continueResponse = await app.fetch(
    new Request("https://aittadb.example.test/device", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${csrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({ csrf_token: csrf, user_code: deviceJson.user_code }),
    }),
  );
  assert.match(
    await continueResponse!.text(),
    /Match the request before the exchange/,
  );
  const decisionCsrf = cookieValue(continueResponse!, "aittadb_csrf");
  const approved = await app.fetch(
    new Request("https://aittadb.example.test/device/decision", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${decisionCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        csrf_token: decisionCsrf,
        user_code: deviceJson.user_code,
        decision: "approve",
      }),
    }),
  );
  assert.equal(approved?.status, 200);
  const approvedHtml = await approved!.text();
  assert.match(approvedHtml, /<h1>Device approved<\/h1>/);
  assert.match(approvedHtml, /Approved\. The device can continue\./);
  assert.match(approvedHtml, /aria-label="Device outcome"/);
  assert.doesNotMatch(approvedHtml, /Error details/);
  assert.doesNotMatch(approvedHtml, /This request stopped here/);
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const token = await app.fetch(
    new Request("https://aittadb.example.test/oauth/token", {
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
    new Request("https://aittadb.example.test/userinfo", {
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
    new Request("https://aittadb.example.test/oauth/introspect", {
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
    new Request("https://aittadb.example.test/oauth/token", {
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
    new Request("https://aittadb.example.test/oauth/token", {
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

  const deniedDevice = await app.fetch(
    new Request("https://aittadb.example.test/oauth/device_authorization", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ client_id: client.id, scope: "openid" }),
    }),
  );
  const deniedDeviceJson = (await deniedDevice?.json()) as {
    device_code: string;
    user_code: string;
  };
  const deniedEntry = await app.fetch(
    new Request(
      `https://aittadb.example.test/device?user_code=${deniedDeviceJson.user_code}`,
    ),
  );
  const deniedEntryCsrf = cookieValue(deniedEntry!, "aittadb_csrf");
  const deniedReview = await app.fetch(
    new Request("https://aittadb.example.test/device", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${deniedEntryCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        csrf_token: deniedEntryCsrf,
        user_code: deniedDeviceJson.user_code,
      }),
    }),
  );
  const deniedDecisionCsrf = cookieValue(deniedReview!, "aittadb_csrf");
  const deniedOutcome = await app.fetch(
    new Request("https://aittadb.example.test/device/decision", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${deniedDecisionCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        csrf_token: deniedDecisionCsrf,
        user_code: deniedDeviceJson.user_code,
        decision: "deny",
      }),
    }),
  );
  assert.equal(deniedOutcome?.status, 200);
  const deniedHtml = await deniedOutcome!.text();
  assert.match(deniedHtml, /<h1>Device denied<\/h1>/);
  assert.match(deniedHtml, /No credentials cross this boundary/);
  assert.match(deniedHtml, /aria-label="Device outcome"/);
  assert.doesNotMatch(deniedHtml, /Error details/);

  const deniedPoll = await app.fetch(
    new Request("https://aittadb.example.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deniedDeviceJson.device_code,
        client_id: client.id,
      }),
    }),
  );
  assert.equal(
    ((await deniedPoll?.json()) as { error: string }).error,
    "access_denied",
  );
});

test("authorization code with PKCE enforces exact redirect URI and one-time code use", async () => {
  const env = await testEnv();
  const store = new MemoryAuthStore();
  const app = createAittaDBWithStore(env, store);
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
      `https://aittadb.example.test/authorize?response_type=code&client_id=${client.id}&redirect_uri=${encodeURIComponent("https://client.example.test/other")}&scope=openid&state=s&code_challenge=${await sha256(verifier)}&code_challenge_method=S256`,
    ),
  );
  assert.equal(bad?.status, 400);

  const authorize = await app.fetch(
    new Request(
      `https://aittadb.example.test/authorize?response_type=code&client_id=${client.id}&redirect_uri=${encodeURIComponent("https://client.example.test/callback")}&scope=openid%20email%20profile&state=s&nonce=n&code_challenge=${await sha256(verifier)}&code_challenge_method=S256`,
    ),
  );
  assert.equal(authorize?.status, 302);
  const consentLocation = authorize?.headers.get("location") ?? "";
  const consent = await app.fetch(new Request(consentLocation));
  assert.match(await consent!.text(), /Scope stays visible and explicit/);
  const csrf = cookieValue(consent!, "aittadb_csrf");
  const requestId =
    new URL(consentLocation).searchParams.get("request_id") ?? "";
  const approved = await app.fetch(
    new Request("https://aittadb.example.test/consent", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${csrf}`,
        origin: "https://aittadb.example.test",
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
    new Request("https://aittadb.example.test/oauth/token", {
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
    new Request("https://aittadb.example.test/oauth/token", {
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

test("AittaDB storage API stores D1 records and R2 files for the local user and client", async () => {
  const env = await testEnv({
    ALLOWED_CORS_ORIGINS: "https://client.example.test",
  });
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const app = createAittaDBWithStore(env, store);
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
    new Request("https://aittadb.example.test/storage/records/app/settings", {
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
    new Request("https://aittadb.example.test/storage/records", {
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
    "https://aittadb.example.test/storage/records/{key}",
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
    new Request("https://aittadb.example.test/storage/records/app/settings", {
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
    new Request("https://aittadb.example.test/storage/files/notes/hello.txt", {
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
    new Request("https://aittadb.example.test/storage/files/notes/hello.txt", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        origin: "https://client.example.test",
      },
    }),
  );
  assert.equal(fileGet?.status, 200);
  assert.equal(fileGet?.headers.get("content-type"), "text/plain");
  assert.equal(
    fileGet?.headers.get("x-aittadb-storage-key"),
    "notes%2Fhello.txt",
  );
  assert.equal(fileGet?.headers.get("x-sites-auth-broker-storage-key"), null);
  assert.equal(
    fileGet?.headers.get("access-control-allow-origin"),
    "https://client.example.test",
  );
  assert.equal(
    fileGet?.headers.get("access-control-expose-headers"),
    "x-aittadb-storage-key",
  );
  assert.equal(await fileGet?.text(), "hello storage");

  const fileList = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
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
    new Request("https://aittadb.example.test/storage/records/app/settings", {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  );
  assert.equal(
    ((await deleteRecord?.json()) as { deleted: boolean }).deleted,
    true,
  );

  const deleteFile = await app.fetch(
    new Request("https://aittadb.example.test/storage/files/notes/hello.txt", {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  );
  assert.equal(
    ((await deleteFile?.json()) as { deleted: boolean }).deleted,
    true,
  );

  const missingFile = await app.fetch(
    new Request("https://aittadb.example.test/storage/files/notes/hello.txt", {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  );
  assert.equal(missingFile?.status, 404);
});
