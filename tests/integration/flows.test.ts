import test from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { loadConfig } from "../../src/config";
import { createAittaDBWithStore } from "../../src/handler";
import { MemoryAuthStore } from "../../src/store/memory";
import { createClientRegistration, issueTokens } from "../../src/oauth";
import { nowSeconds, sha256 } from "../../src/crypto";
import { BROWSER_SESSION_CLIENT_ID } from "../../src/system-client";
import { cookieValue, form, MemoryR2Bucket, testEnv } from "../helpers";

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
    _links: {
      docs: { href: string };
      oidcConfiguration: { href: string };
      session: { href: string };
    };
    actions: {
      authenticate: { href: string };
      deviceAuthorization: { method: string };
    };
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
  assert.equal(
    apiRootJson._links.session.href,
    "https://aittadb.example.test/session",
  );
  assert.equal(
    apiRootJson.actions.authenticate.href,
    "https://aittadb.example.test/session",
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
  assert.match(browserRootHtml, /href="\/session"/);
  assert.match(browserRootHtml, /href="\/device"/);
  assert.match(browserRootHtml, /href="\/storage\/records"/);
  assert.match(browserRootHtml, /href="\/storage\/files"/);
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
  assert.match(browserCssText, /\.content-frame>form button/);
  assert.match(browserCssText, /pre\.json-output/);
  assert.match(browserCssText, /\.table-wrap table/);
  assert.doesNotMatch(browserCssText, /(?:^|\})\s*button,/);
  assert.doesNotMatch(browserCssText, /(?:^|\})\s*input,/);
  assert.doesNotMatch(browserCssText, /(?:^|\})\s*pre\{/);
  assert.doesNotMatch(browserCssText, /(?:^|\})\s*table\{/);

  const [
    visualAsset,
    markAsset,
    fontAsset,
    socialAsset,
    swaggerCss,
    swaggerBundle,
    swaggerBootstrap,
  ] = await Promise.all([
    stat(new URL("../../public/aittadb-boundary.jpg", import.meta.url)),
    stat(new URL("../../public/aittadb-mark.svg", import.meta.url)),
    stat(
      new URL(
        "../../public/fonts/inter-latin-wght-normal.woff2",
        import.meta.url,
      ),
    ),
    stat(new URL("../../public/og.png", import.meta.url)),
    stat(
      new URL("../../public/vendor/swagger-ui/swagger-ui.css", import.meta.url),
    ),
    stat(
      new URL(
        "../../public/vendor/swagger-ui/swagger-ui-bundle.js",
        import.meta.url,
      ),
    ),
    stat(
      new URL("../../public/swagger-ui/aittadb-swagger.js", import.meta.url),
    ),
  ]);
  assert.ok(visualAsset.size > 100_000);
  assert.ok(markAsset.size > 500);
  assert.ok(fontAsset.size > 40_000);
  assert.ok(socialAsset.size > 100_000);
  assert.ok(swaggerCss.size > 100_000);
  assert.ok(swaggerBundle.size > 1_000_000);
  assert.ok(swaggerBootstrap.size > 200);
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

  const browserDiscovery = await app.fetch(
    new Request(
      "https://aittadb.example.test/.well-known/openid-configuration",
      { headers: { accept: "text/html" } },
    ),
  );
  assert.match(
    await browserDiscovery!.text(),
    /<h1>OpenID configuration<\/h1>/,
  );
  const rawDiscovery = await app.fetch(
    new Request(
      "https://aittadb.example.test/.well-known/openid-configuration?format=json",
      { headers: { accept: "text/html" } },
    ),
  );
  assert.match(
    rawDiscovery!.headers.get("content-type") ?? "",
    /^application\/json/,
  );

  const docs = await app.fetch(
    new Request("https://aittadb.example.test/docs", {
      headers: { accept: "text/html" },
    }),
  );
  const docsHtml = await docs!.text();
  assert.match(docsHtml, /id="swagger-ui"/);
  assert.match(docsHtml, /src="\/vendor\/swagger-ui\/swagger-ui-bundle\.js"/);
  assert.match(docsHtml, /src="\/swagger-ui\/aittadb-swagger\.js"/);
  assert.match(docsHtml, /href="\/vendor\/swagger-ui\/swagger-ui\.css"/);
  assert.doesNotMatch(docsHtml, /https:\/\/(unpkg|cdn\.jsdelivr|cdnjs)/);

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

test("public home enters the real protected local AittaDB session", async () => {
  const env = await testEnv();
  const store = new MemoryAuthStore();
  const app = createAittaDBWithStore(env, store);

  const browserSession = await app.fetch(
    new Request("https://aittadb.example.test/session", {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(browserSession?.status, 200);
  const browserHtml = await browserSession!.text();
  assert.match(browserHtml, /<h1>My AittaDB session<\/h1>/);
  assert.match(browserHtml, /Test User/);
  assert.match(browserHtml, /user@example\.test/);
  assert.match(browserHtml, /AittaDB subject/);
  assert.match(browserHtml, /href="\/signout-with-chatgpt\?return_to=%2F"/);
  assert.match(browserHtml, /current session can access its own/);
  assert.match(browserHtml, /Use this session's isolated D1 records/);

  const apiSession = await app.fetch(
    new Request("https://aittadb.example.test/session", {
      headers: { accept: "application/json" },
    }),
  );
  const apiSessionJson = (await apiSession?.json()) as {
    authenticated: boolean;
    user: { sub: string; email: string };
    credentialsForwarded: boolean;
    _links: { signOut: { href: string }; storageRecords: { href: string } };
  };
  assert.equal(apiSessionJson.authenticated, true);
  assert.equal(apiSessionJson.user.email, "user@example.test");
  assert.match(apiSessionJson.user.sub, /^[0-9a-f-]{36}$/);
  assert.equal(apiSessionJson.credentialsForwarded, false);
  assert.equal(
    apiSessionJson._links.storageRecords.href,
    "https://aittadb.example.test/storage/records",
  );

  const repeated = await app.fetch(
    new Request("https://aittadb.example.test/session", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(
    ((await repeated?.json()) as { user: { sub: string } }).user.sub,
    apiSessionJson.user.sub,
  );

  const anonymousEnv = await testEnv({
    TEST_AUTH_EMAIL: undefined,
    TEST_AUTH_FULL_NAME: undefined,
  });
  const anonymousApp = createAittaDBWithStore(
    anonymousEnv,
    new MemoryAuthStore(),
  );
  const anonymousBrowser = await anonymousApp.fetch(
    new Request("https://aittadb.example.test/session", {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(anonymousBrowser?.status, 302);
  assert.equal(
    anonymousBrowser?.headers.get("location"),
    "https://aittadb.example.test/signin-with-chatgpt?return_to=%2Fsession",
  );

  const anonymousApi = await anonymousApp.fetch(
    new Request("https://aittadb.example.test/session", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(anonymousApi?.status, 401);
  assert.equal(
    ((await anonymousApi?.json()) as { error: string }).error,
    "login_required",
  );
});

test("browser protocol representations execute real device, token, UserInfo, introspection, and revocation operations", async () => {
  const env = await testEnv({ DEVICE_POLL_INTERVAL_SECONDS: "1" });
  const store = new MemoryAuthStore();
  const app = createAittaDBWithStore(env, store);
  const { client } = await createClientRegistration(
    {
      type: "public",
      name: "Browser Device Client",
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["openid", "email", "profile", "offline_access"],
      origins: [],
    },
    store,
    nowSeconds(),
  );

  const deviceForm = await app.fetch(
    new Request("https://aittadb.example.test/oauth/device_authorization", {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(deviceForm?.status, 200);
  const deviceFormHtml = await deviceForm!.text();
  assert.match(deviceFormHtml, /<h1>Device authorization<\/h1>/);
  assert.match(deviceFormHtml, /action="\/oauth\/device_authorization"/);
  const deviceCsrf = cookieValue(deviceForm!, "aittadb_csrf");

  const deviceResult = await app.fetch(
    new Request("https://aittadb.example.test/oauth/device_authorization", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${deviceCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        ui: "1",
        csrf_token: deviceCsrf,
        client_id: client.id,
        scope: "openid email profile offline_access",
      }),
    }),
  );
  assert.equal(deviceResult?.status, 200);
  const deviceResultHtml = await deviceResult!.text();
  assert.match(deviceResultHtml, /<h1>Device grant created<\/h1>/);
  const deviceCode = textAreaValue(deviceResultHtml, "device_code_result");
  const userCode =
    deviceResultHtml.match(
      /<span>User code<\/span><strong>([^<]+)<\/strong>/,
    )?.[1] ?? "";
  assert.ok(deviceCode.length > 32);
  assert.match(userCode, /^[A-Z2-9]{8}$/);

  const entry = await app.fetch(
    new Request(
      `https://aittadb.example.test/device?user_code=${encodeURIComponent(userCode)}`,
    ),
  );
  const entryCsrf = cookieValue(entry!, "aittadb_csrf");
  const review = await app.fetch(
    new Request("https://aittadb.example.test/device", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${entryCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({ csrf_token: entryCsrf, user_code: userCode }),
    }),
  );
  const decisionCsrf = cookieValue(review!, "aittadb_csrf");
  const decision = await app.fetch(
    new Request("https://aittadb.example.test/device/decision", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${decisionCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        csrf_token: decisionCsrf,
        user_code: userCode,
        decision: "approve",
      }),
    }),
  );
  assert.equal(decision?.status, 200);

  const tokenForm = await app.fetch(
    new Request("https://aittadb.example.test/oauth/token", {
      headers: { accept: "text/html" },
    }),
  );
  const tokenCsrf = cookieValue(tokenForm!, "aittadb_csrf");
  assert.match(await tokenForm!.text(), /<h1>Token exchange<\/h1>/);
  const tokenResult = await app.fetch(
    new Request("https://aittadb.example.test/oauth/token", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${tokenCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        ui: "1",
        csrf_token: tokenCsrf,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: client.id,
      }),
    }),
  );
  assert.equal(tokenResult?.status, 200);
  const tokenResultHtml = await tokenResult!.text();
  assert.match(tokenResultHtml, /<h1>Credentials issued<\/h1>/);
  assert.doesNotMatch(tokenResultHtml, /access_token=/);
  const accessToken = textAreaValue(tokenResultHtml, "result_access_token");
  const refreshToken = textAreaValue(tokenResultHtml, "result_refresh_token");
  assert.match(accessToken, /^[^.]+\.[^.]+\.[^.]+$/);
  assert.ok(refreshToken.length > 48);

  const userInfoForm = await app.fetch(
    new Request("https://aittadb.example.test/userinfo", {
      headers: { accept: "text/html" },
    }),
  );
  const userInfoCsrf = cookieValue(userInfoForm!, "aittadb_csrf");
  const userInfoResult = await app.fetch(
    new Request("https://aittadb.example.test/userinfo", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${userInfoCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        ui: "1",
        csrf_token: userInfoCsrf,
        access_token: accessToken,
      }),
    }),
  );
  const userInfoHtml = await userInfoResult!.text();
  assert.equal(userInfoResult?.status, 200);
  assert.match(userInfoHtml, /<h1>UserInfo claims<\/h1>/);
  assert.match(userInfoHtml, /user@example\.test/);

  const { client: confidential, secret } = await createClientRegistration(
    {
      type: "confidential",
      name: "Browser Introspection Client",
      redirectUris: ["https://api.example.test/callback"],
      scopes: ["openid"],
      origins: [],
    },
    store,
    nowSeconds(),
  );
  const introspectionForm = await app.fetch(
    new Request("https://aittadb.example.test/oauth/introspect", {
      headers: { accept: "text/html" },
    }),
  );
  const introspectionCsrf = cookieValue(introspectionForm!, "aittadb_csrf");
  const introspectionResult = await app.fetch(
    new Request("https://aittadb.example.test/oauth/introspect", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${introspectionCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        ui: "1",
        csrf_token: introspectionCsrf,
        token: accessToken,
        client_id: confidential.id,
        client_secret: secret || "",
      }),
    }),
  );
  const introspectionHtml = await introspectionResult!.text();
  assert.equal(introspectionResult?.status, 200);
  assert.match(introspectionHtml, /<h1>Introspection result<\/h1>/);
  assert.match(introspectionHtml, /&quot;active&quot;: false/);

  const revocationForm = await app.fetch(
    new Request("https://aittadb.example.test/oauth/revoke", {
      headers: { accept: "text/html" },
    }),
  );
  const revocationCsrf = cookieValue(revocationForm!, "aittadb_csrf");
  const revocationResult = await app.fetch(
    new Request("https://aittadb.example.test/oauth/revoke", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${revocationCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        ui: "1",
        csrf_token: revocationCsrf,
        token: refreshToken,
        token_type_hint: "refresh_token",
      }),
    }),
  );
  assert.equal(revocationResult?.status, 200);
  assert.match(await revocationResult!.text(), /<h1>Revocation accepted<\/h1>/);

  const revokedRefresh = await app.fetch(
    new Request("https://aittadb.example.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: client.id,
      }),
    }),
  );
  assert.equal(
    ((await revokedRefresh?.json()) as { error: string }).error,
    "invalid_grant",
  );

  const missingCsrf = await app.fetch(
    new Request("https://aittadb.example.test/oauth/token", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://aittadb.example.test",
      },
      body: form({ ui: "1", grant_type: "refresh_token" }),
    }),
  );
  assert.equal(missingCsrf?.status, 403);
  assert.match(await missingCsrf!.text(), /CSRF validation failed/);

  const wrongOrigin = await app.fetch(
    new Request("https://aittadb.example.test/oauth/revoke", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${revocationCsrf}`,
        origin: "https://malicious.example.test",
      },
      body: form({
        ui: "1",
        csrf_token: revocationCsrf,
        token: "not-a-token",
      }),
    }),
  );
  assert.equal(wrongOrigin?.status, 403);
  assert.match(await wrongOrigin!.text(), /Origin is not allowed/);

  const apiGetToken = await app.fetch(
    new Request("https://aittadb.example.test/oauth/token", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(apiGetToken?.status, 405);
  assert.equal(apiGetToken?.headers.get("allow"), "POST");
  assert.equal(
    ((await apiGetToken?.json()) as { error: string }).error,
    "invalid_request",
  );
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

  const unsupported = await app.fetch(
    new Request(
      `https://aittadb.example.test/authorize?response_type=token&client_id=${client.id}&redirect_uri=${encodeURIComponent("https://client.example.test/callback")}&scope=openid&state=unsupported-state&code_challenge=${await sha256(verifier)}&code_challenge_method=S256`,
    ),
  );
  assert.equal(unsupported?.status, 302);
  const unsupportedLocation = new URL(
    unsupported?.headers.get("location") ?? "",
  );
  assert.equal(unsupportedLocation.origin, "https://client.example.test");
  assert.equal(
    unsupportedLocation.searchParams.get("error"),
    "unsupported_response_type",
  );
  assert.equal(
    unsupportedLocation.searchParams.get("state"),
    "unsupported-state",
  );

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

test("storage is isolated by local user and client without exposing deployment internals", async () => {
  const adminAllowlist = "private-admin-allowlist@example.test";
  const env = await testEnv({ ADMIN_EMAILS: adminAllowlist });
  const privateJwk = JSON.parse(String(env.JWT_PRIVATE_JWK)) as JsonWebKey;
  assert.equal(typeof privateJwk.d, "string");
  const privateScalar = String(privateJwk.d);
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const app = createAittaDBWithStore(env, store);
  const bucket = env.BUCKET as MemoryR2Bucket;
  const now = nowSeconds();
  const owner = await store.findOrCreateUser(
    {
      email: "storage-owner@example.test",
      fullName: "Storage Owner",
      displayName: "Storage Owner",
    },
    now,
  );
  const otherUser = await store.findOrCreateUser(
    {
      email: "other-user@example.test",
      fullName: "Other User",
      displayName: "Other User",
    },
    now,
  );
  const registration = {
    type: "public" as const,
    redirectUris: ["https://client.example.test/callback"],
    scopes: ["storage.read", "storage.write", "storage.delete"] as const,
    origins: [] as const,
  };
  const { client: ownerClient } = await createClientRegistration(
    { ...registration, name: "Owner Client" },
    store,
    now,
  );
  const { client: otherClient } = await createClientRegistration(
    {
      ...registration,
      name: "Other Client",
      redirectUris: ["https://other.example.test/callback"],
    },
    store,
    now,
  );
  const tokenFor = async (
    user: typeof owner,
    client: typeof ownerClient,
  ): Promise<string> => {
    const tokens = await issueTokens({
      config,
      store,
      user,
      client,
      scope: "storage.read storage.write storage.delete",
      includeRefresh: false,
      now,
    });
    return String(tokens.access_token);
  };
  const ownerToken = await tokenFor(owner, ownerClient);
  const sameUserOtherClientToken = await tokenFor(owner, otherClient);
  const otherUserSameClientToken = await tokenFor(otherUser, ownerClient);
  const recordUrl =
    "https://aittadb.example.test/storage/records/oauth_clients";
  const fileUrl =
    "https://aittadb.example.test/storage/files/internal/secrets.html";

  const ownerRecordWrite = await app.fetch(
    new Request(recordUrl, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ namespace: "application-owned" }),
    }),
  );
  assert.equal(ownerRecordWrite?.status, 200);
  const ownerRecordPayload = (await ownerRecordWrite?.json()) as Record<
    string,
    unknown
  >;
  assert.equal(ownerRecordPayload.key, "oauth_clients");
  assert.equal(Object.hasOwn(ownerRecordPayload, "userId"), false);
  assert.equal(Object.hasOwn(ownerRecordPayload, "clientId"), false);

  const ownerFileWrite = await app.fetch(
    new Request(fileUrl, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "text/html",
      },
      body: "<script>application-owned</script>",
    }),
  );
  assert.equal(ownerFileWrite?.status, 200);
  const ownerFilePayload = (await ownerFileWrite?.json()) as Record<
    string,
    unknown
  >;
  assert.equal(Object.hasOwn(ownerFilePayload, "r2Key"), false);
  assert.equal(Object.hasOwn(ownerFilePayload, "userId"), false);
  assert.equal(Object.hasOwn(ownerFilePayload, "clientId"), false);
  const ownerFile = Array.from(store.storageFiles.values()).find(
    (file) =>
      file.userId === owner.id &&
      file.clientId === ownerClient.id &&
      file.key === "internal/secrets.html",
  );
  assert.ok(ownerFile);
  assert.match(
    ownerFile.r2Key,
    new RegExp(`^users/${owner.id}/clients/${ownerClient.id}/files/`),
  );
  assert.equal(ownerFile.r2Key.includes("internal/secrets.html"), false);
  assert.equal(bucket.objects.has(ownerFile.r2Key), true);

  for (const outsiderToken of [
    sameUserOtherClientToken,
    otherUserSameClientToken,
  ]) {
    const outsiderHeaders = { authorization: `Bearer ${outsiderToken}` };
    const outsiderRecords = await app.fetch(
      new Request("https://aittadb.example.test/storage/records", {
        headers: outsiderHeaders,
      }),
    );
    assert.deepEqual(
      ((await outsiderRecords?.json()) as { records: unknown[] }).records,
      [],
    );
    const outsiderRecordRead = await app.fetch(
      new Request(recordUrl, { headers: outsiderHeaders }),
    );
    assert.equal(outsiderRecordRead?.status, 404);
    const outsiderRecordDelete = await app.fetch(
      new Request(recordUrl, { method: "DELETE", headers: outsiderHeaders }),
    );
    assert.equal(outsiderRecordDelete?.status, 200);
    const ownerRecordAfterDelete = await app.fetch(
      new Request(recordUrl, {
        headers: { authorization: `Bearer ${ownerToken}` },
      }),
    );
    assert.deepEqual(
      ((await ownerRecordAfterDelete?.json()) as { value: unknown }).value,
      { namespace: "application-owned" },
    );
    const outsiderRecordWrite = await app.fetch(
      new Request(recordUrl, {
        method: "PUT",
        headers: {
          ...outsiderHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({ namespace: "outsider-owned" }),
      }),
    );
    assert.equal(outsiderRecordWrite?.status, 200);
    const ownerRecordAfterWrite = await app.fetch(
      new Request(recordUrl, {
        headers: { authorization: `Bearer ${ownerToken}` },
      }),
    );
    assert.deepEqual(
      ((await ownerRecordAfterWrite?.json()) as { value: unknown }).value,
      { namespace: "application-owned" },
    );

    const outsiderFiles = await app.fetch(
      new Request("https://aittadb.example.test/storage/files", {
        headers: outsiderHeaders,
      }),
    );
    assert.deepEqual(
      ((await outsiderFiles?.json()) as { files: unknown[] }).files,
      [],
    );
    const outsiderFileRead = await app.fetch(
      new Request(fileUrl, { headers: outsiderHeaders }),
    );
    assert.equal(outsiderFileRead?.status, 404);
    const outsiderFileDelete = await app.fetch(
      new Request(fileUrl, { method: "DELETE", headers: outsiderHeaders }),
    );
    assert.equal(outsiderFileDelete?.status, 200);
    const ownerFileAfterDelete = await app.fetch(
      new Request(fileUrl, {
        headers: { authorization: `Bearer ${ownerToken}` },
      }),
    );
    assert.equal(ownerFileAfterDelete?.status, 200);
    assert.equal(
      ownerFileAfterDelete?.headers.get("content-disposition"),
      "attachment; filename=\"aittadb-download\"; filename*=UTF-8''secrets.html",
    );
    assert.equal(
      await ownerFileAfterDelete?.text(),
      "<script>application-owned</script>",
    );
    const outsiderFileWrite = await app.fetch(
      new Request(fileUrl, {
        method: "PUT",
        headers: {
          ...outsiderHeaders,
          "content-type": "text/plain",
        },
        body: "outsider-owned",
      }),
    );
    assert.equal(outsiderFileWrite?.status, 200);
    const ownerFileAfterWrite = await app.fetch(
      new Request(fileUrl, {
        headers: { authorization: `Bearer ${ownerToken}` },
      }),
    );
    assert.equal(
      await ownerFileAfterWrite?.text(),
      "<script>application-owned</script>",
    );
  }

  const ownerRecord = await app.fetch(
    new Request(recordUrl, {
      headers: { authorization: `Bearer ${ownerToken}` },
    }),
  );
  const ownerFileRead = await app.fetch(
    new Request(fileUrl, {
      headers: { authorization: `Bearer ${ownerToken}` },
    }),
  );
  const internalRoute = await app.fetch(
    new Request("https://aittadb.example.test/storage/d1", {
      headers: { authorization: `Bearer ${ownerToken}` },
    }),
  );
  assert.equal(internalRoute?.status, 404);
  const jwksResponse = await app.fetch(
    new Request(
      "https://aittadb.example.test/.well-known/jwks.json?format=json",
      { headers: { accept: "application/json" } },
    ),
  );
  const jwks = (await jwksResponse?.clone().json()) as {
    keys: Array<Record<string, unknown>>;
  };
  assert.equal(Object.hasOwn(jwks.keys[0], "d"), false);
  assert.deepEqual(jwks.keys[0].key_ops, ["verify"]);

  const checkedResponses = [
    ownerRecord,
    ownerFileRead,
    internalRoute,
    jwksResponse,
    await app.fetch(
      new Request("https://aittadb.example.test/", {
        headers: { accept: "application/json" },
      }),
    ),
    await app.fetch(
      new Request("https://aittadb.example.test/health", {
        headers: { accept: "application/json" },
      }),
    ),
    await app.fetch(
      new Request("https://aittadb.example.test/openapi.json?format=json", {
        headers: { accept: "application/json" },
      }),
    ),
  ];
  for (const response of checkedResponses) {
    const body = await response?.clone().text();
    assert.equal(body?.includes(privateScalar), false);
    assert.equal(body?.includes(adminAllowlist), false);
    assert.equal(body?.includes(ownerFile.r2Key), false);
    assert.equal(body?.includes("JWT_PRIVATE_JWK"), false);
    assert.equal(body?.includes("ADMIN_EMAILS"), false);
  }
});

test("browser storage representations execute real scoped D1 and R2 operations", async () => {
  const env = await testEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const app = createAittaDBWithStore(env, store);
  const now = nowSeconds();
  const user = await store.findOrCreateUser(
    {
      email: "storage-browser@example.test",
      fullName: "Storage Browser",
      displayName: "Storage Browser",
    },
    now,
  );
  const { client } = await createClientRegistration(
    {
      type: "public",
      name: "Storage Browser Client",
      redirectUris: ["https://storage.example.test/callback"],
      scopes: ["storage.read", "storage.write", "storage.delete"],
      origins: [],
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

  const recordForm = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      headers: { accept: "text/html" },
    }),
  );
  const recordCsrf = cookieValue(recordForm!, "aittadb_csrf");
  const recordFormHtml = await recordForm!.text();
  assert.match(recordFormHtml, /<h1>JSON record storage<\/h1>/);
  assert.match(recordFormHtml, /action="\/storage\/records"/);
  assert.doesNotMatch(recordFormHtml, /value="Bearer/);

  const writeRecord = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${recordCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        ui: "1",
        csrf_token: recordCsrf,
        operation: "write",
        access_token: accessToken,
        key: "browser/settings",
        value: JSON.stringify({ theme: "teal", count: 2 }),
      }),
    }),
  );
  const writeRecordHtml = await writeRecord!.text();
  assert.equal(writeRecord?.status, 200);
  assert.match(writeRecordHtml, /<h1>Record operation result<\/h1>/);
  assert.match(writeRecordHtml, /browser\/settings/);
  assert.doesNotMatch(
    writeRecordHtml,
    new RegExp(accessToken.replaceAll(".", "\\.")),
  );

  const readRecord = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${recordCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        ui: "1",
        csrf_token: recordCsrf,
        operation: "read",
        access_token: accessToken,
        key: "browser/settings",
      }),
    }),
  );
  assert.match(await readRecord!.text(), /&quot;theme&quot;: &quot;teal&quot;/);

  const listRecords = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${recordCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        ui: "1",
        csrf_token: recordCsrf,
        operation: "list",
        access_token: accessToken,
      }),
    }),
  );
  assert.match(await listRecords!.text(), /browser\/settings/);

  const itemForm = await app.fetch(
    new Request(
      "https://aittadb.example.test/storage/records/browser/settings",
      { headers: { accept: "text/html" } },
    ),
  );
  assert.match(await itemForm!.text(), /name="key" value="browser\/settings"/);

  const fileForm = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
      headers: { accept: "text/html" },
    }),
  );
  const fileCsrf = cookieValue(fileForm!, "aittadb_csrf");
  const fileFormHtml = await fileForm!.text();
  assert.match(fileFormHtml, /<h1>File object storage<\/h1>/);
  assert.match(fileFormHtml, /enctype="multipart\/form-data"/);

  const uploadForm = new FormData();
  uploadForm.set("ui", "1");
  uploadForm.set("csrf_token", fileCsrf);
  uploadForm.set("operation", "upload");
  uploadForm.set("access_token", accessToken);
  uploadForm.set("key", "browser/hello.txt");
  uploadForm.set(
    "file",
    new File(["hello from browser storage"], "hello.txt", {
      type: "text/plain",
    }),
  );
  const uploadFile = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
      method: "POST",
      headers: {
        accept: "text/html",
        cookie: `aittadb_csrf=${fileCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: uploadForm,
    }),
  );
  assert.equal(uploadFile?.status, 200);
  assert.match(await uploadFile!.text(), /<h1>File operation result<\/h1>/);

  const listFileForm = new FormData();
  listFileForm.set("ui", "1");
  listFileForm.set("csrf_token", fileCsrf);
  listFileForm.set("operation", "list");
  listFileForm.set("access_token", accessToken);
  const listFiles = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
      method: "POST",
      headers: {
        accept: "text/html",
        cookie: `aittadb_csrf=${fileCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: listFileForm,
    }),
  );
  assert.match(await listFiles!.text(), /browser\/hello\.txt/);

  const downloadForm = new FormData();
  downloadForm.set("ui", "1");
  downloadForm.set("csrf_token", fileCsrf);
  downloadForm.set("operation", "download");
  downloadForm.set("access_token", accessToken);
  downloadForm.set("key", "browser/hello.txt");
  const downloadFile = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
      method: "POST",
      headers: {
        accept: "text/html",
        cookie: `aittadb_csrf=${fileCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: downloadForm,
    }),
  );
  assert.equal(downloadFile?.headers.get("content-type"), "text/plain");
  assert.match(
    downloadFile?.headers.get("content-disposition") ?? "",
    /filename\*=UTF-8''hello\.txt/,
  );
  assert.equal(await downloadFile!.text(), "hello from browser storage");

  const deleteFileForm = new FormData();
  deleteFileForm.set("ui", "1");
  deleteFileForm.set("csrf_token", fileCsrf);
  deleteFileForm.set("operation", "delete");
  deleteFileForm.set("access_token", accessToken);
  deleteFileForm.set("key", "browser/hello.txt");
  const deleteFile = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
      method: "POST",
      headers: {
        accept: "text/html",
        cookie: `aittadb_csrf=${fileCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: deleteFileForm,
    }),
  );
  assert.match(await deleteFile!.text(), /&quot;deleted&quot;: true/);

  const deleteRecord = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${recordCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        ui: "1",
        csrf_token: recordCsrf,
        operation: "delete",
        access_token: accessToken,
        key: "browser/settings",
      }),
    }),
  );
  assert.match(await deleteRecord!.text(), /&quot;deleted&quot;: true/);

  const missingRecord = await app.fetch(
    new Request(
      "https://aittadb.example.test/storage/records/browser/settings",
      { headers: { authorization: `Bearer ${accessToken}` } },
    ),
  );
  assert.equal(missingRecord?.status, 404);
  const missingFile = await app.fetch(
    new Request(
      "https://aittadb.example.test/storage/files/browser/hello.txt",
      { headers: { authorization: `Bearer ${accessToken}` } },
    ),
  );
  assert.equal(missingFile?.status, 404);

  const oversizedRecord = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${recordCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        ui: "1",
        csrf_token: recordCsrf,
        operation: "write",
        access_token: accessToken,
        key: "browser/too-large",
        value: JSON.stringify("x".repeat(65_536)),
      }),
    }),
  );
  assert.equal(oversizedRecord?.status, 413);

  const missingCsrf = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://aittadb.example.test",
      },
      body: form({
        ui: "1",
        operation: "list",
        access_token: accessToken,
      }),
    }),
  );
  assert.equal(missingCsrf?.status, 403);
  assert.match(await missingCsrf!.text(), /CSRF validation failed/);

  const oversizedMultipart = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "multipart/form-data; boundary=oversized",
        "content-length": String(11 * 1024 * 1024),
        origin: "https://aittadb.example.test",
      },
      body: "--oversized--\r\n",
    }),
  );
  assert.equal(oversizedMultipart?.status, 413);
});

test("current signed-in session drives UserInfo and isolated record and file operations", async () => {
  const env = await testEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const app = createAittaDBWithStore(env, store);

  const recordForm = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      headers: { accept: "text/html" },
    }),
  );
  const recordCsrf = cookieValue(recordForm!, "aittadb_csrf");
  const recordHtml = await recordForm!.text();
  assert.match(recordHtml, /option value="session" selected/);
  assert.match(recordHtml, /Current signed-in session/);
  assert.match(recordHtml, /personal browser-session namespace/);

  const sessionWrite = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${recordCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        ui: "1",
        csrf_token: recordCsrf,
        auth_mode: "session",
        operation: "write",
        key: "current/preferences",
        value: JSON.stringify({ density: "compact" }),
      }),
    }),
  );
  const sessionWriteHtml = await sessionWrite!.text();
  assert.equal(sessionWrite?.status, 200);
  assert.match(sessionWriteHtml, /current\/preferences/);
  assert.doesNotMatch(sessionWriteHtml, /eyJ[A-Za-z0-9_-]+\./);

  const localUserId = store.usersByEmail.get("user@example.test");
  assert.ok(localUserId);
  const browserRecord = await store.getStorageRecord(
    localUserId,
    BROWSER_SESSION_CLIENT_ID,
    "current/preferences",
  );
  assert.deepEqual(JSON.parse(browserRecord!.valueJson), {
    density: "compact",
  });

  const { client } = await createClientRegistration(
    {
      type: "public",
      name: "Separate application client",
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["storage.read", "storage.write", "storage.delete"],
      origins: [],
    },
    store,
    nowSeconds(),
  );
  const user = await store.getUser(localUserId);
  assert.ok(user);
  const appTokens = await issueTokens({
    config,
    store,
    user,
    client,
    scope: "storage.read storage.write storage.delete",
    includeRefresh: false,
    now: nowSeconds(),
  });
  const appToken = String(appTokens.access_token);
  const applicationRecords = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      headers: { authorization: `Bearer ${appToken}` },
    }),
  );
  assert.deepEqual(
    ((await applicationRecords!.json()) as { records: unknown[] }).records,
    [],
  );

  const fileForm = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
      headers: { accept: "text/html" },
    }),
  );
  const fileCsrf = cookieValue(fileForm!, "aittadb_csrf");
  assert.match(await fileForm!.text(), /option value="session" selected/);
  const upload = new FormData();
  upload.set("ui", "1");
  upload.set("csrf_token", fileCsrf);
  upload.set("auth_mode", "session");
  upload.set("operation", "upload");
  upload.set("key", "current/note.txt");
  upload.set(
    "file",
    new File(["session-owned"], "note.txt", { type: "text/plain" }),
  );
  const sessionUpload = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
      method: "POST",
      headers: {
        accept: "text/html",
        cookie: `aittadb_csrf=${fileCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: upload,
    }),
  );
  const sessionUploadHtml = await sessionUpload!.text();
  assert.equal(sessionUpload?.status, 200);
  const browserFile = await store.getStorageFileMetadata(
    localUserId,
    BROWSER_SESSION_CLIENT_ID,
    "current/note.txt",
  );
  assert.ok(browserFile);
  assert.equal(sessionUploadHtml.includes(browserFile.r2Key), false);
  assert.doesNotMatch(sessionUploadHtml, /eyJ[A-Za-z0-9_-]+\./);
  const applicationFiles = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
      headers: { authorization: `Bearer ${appToken}` },
    }),
  );
  assert.deepEqual(
    ((await applicationFiles!.json()) as { files: unknown[] }).files,
    [],
  );

  const userInfoForm = await app.fetch(
    new Request("https://aittadb.example.test/userinfo", {
      headers: { accept: "text/html" },
    }),
  );
  const userInfoCsrf = cookieValue(userInfoForm!, "aittadb_csrf");
  assert.match(await userInfoForm!.text(), /option value="session" selected/);
  const currentUserInfo = await app.fetch(
    new Request("https://aittadb.example.test/userinfo", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${userInfoCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        ui: "1",
        csrf_token: userInfoCsrf,
        auth_mode: "session",
      }),
    }),
  );
  const currentUserInfoHtml = await currentUserInfo!.text();
  assert.equal(currentUserInfo?.status, 200);
  assert.match(currentUserInfoHtml, /user@example\.test/);
  assert.match(currentUserInfoHtml, /Test User/);
  assert.doesNotMatch(currentUserInfoHtml, /eyJ[A-Za-z0-9_-]+\./);

  const signedOutEnv = await testEnv({
    TEST_AUTH_EMAIL: undefined,
    TEST_AUTH_FULL_NAME: undefined,
  });
  const signedOutApp = createAittaDBWithStore(
    signedOutEnv,
    new MemoryAuthStore(),
  );
  const signedOutForm = await signedOutApp.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      headers: { accept: "text/html" },
    }),
  );
  const signedOutCsrf = cookieValue(signedOutForm!, "aittadb_csrf");
  const signedOutHtml = await signedOutForm!.text();
  assert.match(signedOutHtml, /option value="token" selected/);
  assert.match(signedOutHtml, /Sign in with ChatGPT/);
  const signInRedirect = await signedOutApp.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${signedOutCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        ui: "1",
        csrf_token: signedOutCsrf,
        auth_mode: "session",
        operation: "list",
      }),
    }),
  );
  assert.equal(signInRedirect?.status, 302);
  assert.equal(
    signInRedirect?.headers.get("location"),
    "https://aittadb.example.test/signin-with-chatgpt?return_to=%2Fstorage%2Frecords",
  );
});

test("reserved browser-session client is hidden, non-administrable, and rejected by OAuth", async () => {
  const env = await testEnv({ TEST_AUTH_EMAIL: "admin@example.test" });
  const store = new MemoryAuthStore();
  const app = createAittaDBWithStore(env, store);
  const internalClient = await store.getClient(BROWSER_SESSION_CLIENT_ID);
  assert.ok(internalClient);
  assert.equal(
    (await store.listClients()).some(
      (client) => client.id === BROWSER_SESSION_CLIENT_ID,
    ),
    false,
  );
  await store.setClientDisabled(BROWSER_SESSION_CLIENT_ID, nowSeconds());
  await store.rotateClientSecret(
    BROWSER_SESSION_CLIENT_ID,
    await sha256("must-not-change"),
  );
  assert.equal(
    (await store.getClient(BROWSER_SESSION_CLIENT_ID))?.disabledAt,
    null,
  );
  assert.equal(
    await store.getClientSecretHash(BROWSER_SESSION_CLIENT_ID),
    null,
  );

  const admin = await app.fetch(
    new Request("https://aittadb.example.test/admin/clients", {
      headers: { accept: "text/html" },
    }),
  );
  const adminCsrf = cookieValue(admin!, "aittadb_csrf");
  assert.equal(
    (await admin!.text()).includes(BROWSER_SESSION_CLIENT_ID),
    false,
  );
  const guessedMutation = await app.fetch(
    new Request("https://aittadb.example.test/admin/clients", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${adminCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        csrf_token: adminCsrf,
        action: "disable",
        client_id: BROWSER_SESSION_CLIENT_ID,
      }),
    }),
  );
  assert.equal(guessedMutation?.status, 404);

  const device = await app.fetch(
    new Request("https://aittadb.example.test/oauth/device_authorization", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: BROWSER_SESSION_CLIENT_ID,
        scope: "storage.read",
      }),
    }),
  );
  assert.equal(device?.status, 401);
  assert.equal(
    ((await device!.json()) as { error: string }).error,
    "invalid_client",
  );

  const authorize = await app.fetch(
    new Request(
      `https://aittadb.example.test/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: BROWSER_SESSION_CLIENT_ID,
        redirect_uri: "https://attacker.example.test/callback",
        code_challenge_method: "S256",
        code_challenge: "A".repeat(43),
      })}`,
    ),
  );
  assert.equal(authorize?.status, 400);
  assert.equal(
    ((await authorize!.json()) as { error: string }).error,
    "invalid_client",
  );

  const token = await app.fetch(
    new Request("https://aittadb.example.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: BROWSER_SESSION_CLIENT_ID,
        device_code: "not-a-device-code",
      }),
    }),
  );
  assert.equal(token?.status, 401);
  assert.equal(
    ((await token!.json()) as { error: string }).error,
    "invalid_client",
  );

  const first = await createClientRegistration(
    {
      type: "public",
      name: "First device client",
      redirectUris: ["https://first.example.test/callback"],
      scopes: ["openid"],
      origins: [],
    },
    store,
    nowSeconds(),
  );
  const second = await createClientRegistration(
    {
      type: "public",
      name: "Second device client",
      redirectUris: ["https://second.example.test/callback"],
      scopes: ["openid"],
      origins: [],
    },
    store,
    nowSeconds(),
  );
  const issued = await app.fetch(
    new Request("https://aittadb.example.test/oauth/device_authorization", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ client_id: first.client.id, scope: "openid" }),
    }),
  );
  const issuedPayload = (await issued!.json()) as { device_code: string };
  const mismatchedPoll = await app.fetch(
    new Request("https://aittadb.example.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: second.client.id,
        device_code: issuedPayload.device_code,
      }),
    }),
  );
  assert.equal(mismatchedPoll?.status, 400);
  assert.equal(
    ((await mismatchedPoll!.json()) as { error: string }).error,
    "invalid_grant",
  );
});

function textAreaValue(html: string, id: string): string {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = html.match(
    new RegExp(`<textarea id="${escapedId}"[^>]*>([^<]*)</textarea>`),
  )?.[1];
  if (!value) throw new Error(`Missing textarea value for ${id}`);
  return value;
}
