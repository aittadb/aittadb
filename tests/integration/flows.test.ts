import test from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { loadConfig } from "../../src/config";
import { MemoryAuthStore } from "../../src/store/memory";
import { createClientRegistration, issueTokens } from "../../src/oauth";
import { nowSeconds, publicJwk, sha256, verifyJwt } from "../../src/crypto";
import { BROWSER_SESSION_CLIENT_ID } from "../../src/system-client";
import {
  cookieValue,
  createTestAittaDB,
  form,
  MemoryR2Bucket,
  testEnv,
} from "../helpers";

test("metadata routes negotiate HTML for browsers and JSON for API clients", async () => {
  const env = await testEnv();
  const app = createTestAittaDB(env, new MemoryAuthStore());

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
    api_version: string;
    type: string;
    data: {
      service: string;
      description: string;
      hostingPlatform: string;
      upstreamSignIn: {
        source: string;
        identitySignal: string;
        stableSubjectSupplied: boolean;
        credentialsForwarded: boolean;
      };
      sessionIssuer: string;
      officialOpenAIProduct: boolean;
      features: {
        records: boolean;
        files: boolean;
        statistics: boolean;
        oauthApps: boolean;
      };
      capabilities: string[];
      plannedCapabilities: string[];
    };
    links: Array<{ rel: string[]; href: string }>;
    actions: Array<{ name: string; href: string; method: string }>;
  };
  assert.equal(apiRoot?.headers.get("aittadb-api-version"), "0.1");
  assert.equal(apiRootJson.api_version, "0.1");
  assert.equal(apiRootJson.type, "service");
  assert.equal(apiRootJson.data.service, "AittaDB");
  assert.match(apiRootJson.data.description, /source-available project/i);
  assert.match(
    apiRootJson.data.description,
    /hosted application backend for third-party apps/i,
  );
  assert.match(apiRootJson.data.description, /FSL-1\.1-MIT/);
  assert.match(
    apiRootJson.data.description,
    /MIT license for immediate use is also available commercially/i,
  );
  assert.doesNotMatch(
    apiRootJson.data.description,
    /third-party, non-official project/i,
  );
  assert.match(
    apiRootJson.data.description,
    /depends on OpenAI-hosted ChatGPT Sites for runtime, ChatGPT sign-in, D1, R2, configuration, and secrets/,
  );
  assert.match(
    apiRootJson.data.description,
    /never forwards ChatGPT credentials/,
  );
  assert.equal(apiRootJson.data.hostingPlatform, "OpenAI-hosted ChatGPT Sites");
  assert.equal(
    apiRootJson.data.upstreamSignIn.source,
    "ChatGPT sign-in inside ChatGPT Sites",
  );
  assert.equal(
    apiRootJson.data.upstreamSignIn.identitySignal,
    "server-side email and optional display name",
  );
  assert.equal(apiRootJson.data.upstreamSignIn.stableSubjectSupplied, false);
  assert.equal(apiRootJson.data.upstreamSignIn.credentialsForwarded, false);
  assert.equal(apiRootJson.data.sessionIssuer, "AittaDB");
  assert.equal(apiRootJson.data.officialOpenAIProduct, false);
  assert.deepEqual(apiRootJson.data.features, {
    records: true,
    files: true,
    statistics: true,
    oauthApps: false,
  });
  assert.deepEqual(apiRootJson.data.capabilities, [
    "ChatGPT sign-in inside ChatGPT Sites mapped to a separate AittaDB user",
    "AittaDB-issued OAuth 2.0, OpenID Connect, and JWT sessions",
    "D1-backed JSON records isolated by AittaDB user and client",
    "R2-backed files with D1 metadata isolated by AittaDB user and client",
  ]);
  assert.deepEqual(apiRootJson.data.plannedCapabilities, [
    "Persistent events and long-polling delivery",
  ]);
  assert.equal(Object.hasOwn(apiRootJson.data, "tokenAuthority"), false);
  assert.equal(
    apiRootJson.links.find((item) => item.rel.includes("documentation"))?.href,
    "https://aittadb.example.test/docs",
  );
  assert.equal(
    apiRootJson.links.find((item) => item.rel.includes("openid-configuration"))
      ?.href,
    "https://aittadb.example.test/.well-known/openid-configuration",
  );
  assert.equal(
    apiRootJson.links.find((item) => item.rel.includes("session"))?.href,
    "https://aittadb.example.test/session",
  );
  assert.equal(
    apiRootJson.links.find((item) => item.rel.includes("statistics"))?.href,
    "https://aittadb.example.test/statistics",
  );
  assert.equal(
    apiRootJson.links.find((item) => item.rel.includes("privacy-policy"))?.href,
    "https://aittadb.example.test/privacy",
  );
  assert.equal(
    apiRootJson.actions.find((item) => item.name === "sign-out")?.href,
    "https://aittadb.example.test/signout-with-chatgpt?return_to=%2F",
  );
  assert.equal(
    apiRootJson.actions.find((item) => item.name === "read-statistics")?.href,
    "https://aittadb.example.test/statistics",
  );

  const vendorRoot = await app.fetch(
    new Request("https://aittadb.example.test/", {
      headers: {
        accept: "application/vnd.aittadb+json; version=0.1",
        "user-agent": "Mozilla/5.0",
      },
    }),
  );
  assert.match(
    vendorRoot?.headers.get("content-type") ?? "",
    /^application\/vnd\.aittadb\+json; version=0\.1/,
  );
  assert.equal(
    ((await vendorRoot?.json()) as { api_version: string }).api_version,
    "0.1",
  );

  const unsupportedVersion = await app.fetch(
    new Request("https://aittadb.example.test/", {
      headers: { accept: "application/vnd.aittadb+json; version=9" },
    }),
  );
  assert.equal(unsupportedVersion?.status, 406);
  assert.equal(
    ((await unsupportedVersion?.json()) as { error: string }).error,
    "not_acceptable",
  );

  const missingVersion = await app.fetch(
    new Request("https://aittadb.example.test/", {
      headers: { accept: "application/vnd.aittadb+json" },
    }),
  );
  assert.equal(missingVersion?.status, 406);

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
  assert.match(
    browserRootHtml,
    /Identity, sessions, JSON data, and files for connected applications\./,
  );
  const rootTrustNotice = /<p class="note">([\s\S]*?)<\/p>/.exec(
    browserRootHtml,
  )?.[1];
  assert.ok(rootTrustNotice);
  assert.doesNotMatch(rootTrustNotice, /Persistent events are planned/);
  assert.match(rootTrustNotice, /Source-available under FSL-1\.1-MIT/);
  assert.match(rootTrustNotice, /FSL-1\.1-MIT/);
  assert.match(
    rootTrustNotice,
    /ChatGPT provides browser sign-in inside ChatGPT Sites/,
  );
  assert.match(rootTrustNotice, /creates a separate local identity/);
  assert.match(rootTrustNotice, /issues its own credentials/);
  assert.match(
    rootTrustNotice,
    /never receives or forwards ChatGPT credentials/,
  );
  assert.doesNotMatch(
    rootTrustNotice,
    /AittaDB runs on OpenAI-hosted ChatGPT Sites/,
  );
  assert.doesNotMatch(rootTrustNotice, /ChatGPT OAuth/i);
  assert.doesNotMatch(rootTrustNotice, /available commercially/);
  assert.doesNotMatch(
    rootTrustNotice,
    /not affiliated with or endorsed by OpenAI/,
  );
  assert.doesNotMatch(rootTrustNotice, /third-party, non-official project/);
  assert.doesNotMatch(rootTrustNotice, /remains independent from OpenAI/);
  assert.match(browserRootHtml, /Session issuer/);
  assert.match(browserRootHtml, /Hosting platform/);
  assert.match(browserRootHtml, /OpenAI-hosted ChatGPT Sites/);
  assert.match(browserRootHtml, /Feature availability/);
  assert.match(
    browserRootHtml,
    /Records on · Files on · Statistics on · OAuth Apps off/,
  );
  assert.doesNotMatch(browserRootHtml, /Official OpenAI product/);
  assert.match(browserRootHtml, />Licensing and platform details<\/a>/);
  assert.match(browserRootHtml, /Identity \/ Data \/ Files \/ Events/);
  assert.match(browserRootHtml, />Sign out<\/a>/);
  assert.doesNotMatch(browserRootHtml, />Sign in to AittaDB<\/a>/);
  assert.match(
    browserRootHtml,
    /View your AittaDB identity and open your private records and files\./,
  );
  assert.doesNotMatch(browserRootHtml, /Sign in to view your AittaDB identity/);
  assert.match(browserRootHtml, /href="\/session"/);
  assert.match(browserRootHtml, /href="\/storage\/records"/);
  assert.match(browserRootHtml, /href="\/storage\/files"/);
  assert.match(browserRootHtml, /href="\/statistics"/);
  assert.match(browserRootHtml, /href="\/privacy"/);
  assert.match(browserRootHtml, /href="\/docs"/);
  assert.doesNotMatch(browserRootHtml, /href="\/authorize"/);
  assert.doesNotMatch(browserRootHtml, /href="\/device"/);
  assert.doesNotMatch(
    browserRootHtml,
    /Independent OAuth and OpenID Connect sessions with per-user application data/,
  );
  assert.doesNotMatch(browserRootHtml, /Token authority/i);
  assert.doesNotMatch(browserRootHtml, /Sites identity/);
  assert.doesNotMatch(browserRootHtml, /Sites Auth Broker/);
  assert.match(browserRootHtml, /https:\/\/github\.com\/aittadb\/aittadb/);
  assert.match(browserRootHtml, /View source on GitHub/);
  assert.match(browserRootHtml, /aria-label="Project information"/);
  assert.match(browserRoot!.headers.get("content-type") ?? "", /^text\/html/);
  const contentSecurityPolicy =
    browserRoot!.headers.get("content-security-policy") ?? "";
  assert.match(contentSecurityPolicy, /font-src 'self'/);
  assert.match(contentSecurityPolicy, /img-src 'self'/);
  assert.match(contentSecurityPolicy, /script-src 'self'/);

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
  assert.match(browserCssText, /\.stacked-form button/);
  assert.match(browserCssText, /pre\.json-output/);
  assert.match(browserCssText, /\.table-wrap table/);
  assert.doesNotMatch(browserCssText, /(?:^|\})\s*button,/);
  assert.doesNotMatch(browserCssText, /(?:^|\})\s*input,/);
  assert.doesNotMatch(browserCssText, /(?:^|\})\s*pre\{/);
  assert.doesNotMatch(browserCssText, /(?:^|\})\s*table\{/);

  const browserScript = await app.fetch(
    new Request("https://aittadb.example.test/auth-ui.js", {
      headers: { accept: "text/javascript,*/*;q=0.1" },
    }),
  );
  assert.match(
    browserScript!.headers.get("content-type") ?? "",
    /^text\/javascript/,
  );
  assert.match(await browserScript!.text(), /data-key-action-template/);

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
    data: { ok: boolean; service: string };
    links: Array<{ rel: string[]; href: string }>;
  };
  assert.equal(cliHealthJson.data.ok, true);
  assert.equal(cliHealthJson.data.service, "aittadb");
  assert.equal(
    cliHealthJson.links.find((item) => item.rel.includes("service"))?.href,
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

  const cliHtml = await app.fetch(
    new Request("https://aittadb.example.test/health", {
      headers: { accept: "text/html", "user-agent": "curl/8.7.1" },
    }),
  );
  assert.match(cliHtml?.headers.get("content-type") ?? "", /^text\/html/);

  const browserDiscovery = await app.fetch(
    new Request(
      "https://aittadb.example.test/.well-known/openid-configuration",
      { headers: { accept: "text/html" } },
    ),
  );
  const browserDiscoveryHtml = await browserDiscovery!.text();
  assert.match(browserDiscoveryHtml, /<h1>OpenID configuration<\/h1>/);
  assert.match(
    browserDiscoveryHtml,
    /Published OpenID Provider metadata for this AittaDB issuer\./,
  );
  assert.doesNotMatch(browserDiscoveryHtml, /independent AittaDB issuer/i);
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
    links: Array<{ rel: string[]; href: string }>;
    actions: unknown[];
  };
  assert.equal(apiMissingJson.error, "not_found");
  assert.equal(
    apiMissingJson.links.find((item) => item.rel.includes("documentation"))
      ?.href,
    "/docs",
  );
  assert.deepEqual(apiMissingJson.actions, []);

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

  const unavailableAdmin = await app.fetch(
    new Request("https://aittadb.example.test/admin/clients", {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }),
  );
  assert.equal(unavailableAdmin?.status, 503);
  const unavailableAdminHtml = await unavailableAdmin!.text();
  assert.match(unavailableAdminHtml, /<h1>Service unavailable<\/h1>/);
  assert.match(unavailableAdminHtml, /OAuth Apps is disabled/);
});

test("public home enters the real protected local AittaDB session", async () => {
  const env = await testEnv();
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);

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
  assert.match(browserHtml, /current sign-in can access its own persistent/);
  assert.match(browserHtml, /Use this identity's isolated D1 records/);
  assert.match(browserHtml, /Open my records/);
  assert.doesNotMatch(browserHtml, /href="\/authorize"/);
  assert.doesNotMatch(browserHtml, /href="\/device"/);
  assert.doesNotMatch(browserHtml, /href="\/oauth\/device_authorization"/);
  assert.match(browserHtml, /<a href="\/privacy">Privacy<\/a>/);

  const apiSession = await app.fetch(
    new Request("https://aittadb.example.test/session", {
      headers: { accept: "application/json" },
    }),
  );
  const apiSessionJson = (await apiSession?.json()) as {
    data: {
      authenticated: boolean;
      user: { sub: string; email: string };
      credentialsForwarded: boolean;
    };
    links: Array<{ rel: string[]; href: string }>;
  };
  assert.equal(apiSessionJson.data.authenticated, true);
  assert.equal(apiSessionJson.data.user.email, "user@example.test");
  assert.match(apiSessionJson.data.user.sub, /^[0-9a-f-]{36}$/);
  assert.equal(apiSessionJson.data.credentialsForwarded, false);
  assert.equal(
    apiSessionJson.links.find((item) => item.rel.includes("storage-records"))
      ?.href,
    "https://aittadb.example.test/storage/records",
  );
  assert.equal(
    apiSessionJson.links.find((item) => item.rel.includes("privacy-policy"))
      ?.href,
    "https://aittadb.example.test/privacy",
  );

  const repeated = await app.fetch(
    new Request("https://aittadb.example.test/session", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(
    ((await repeated?.json()) as { data: { user: { sub: string } } }).data.user
      .sub,
    apiSessionJson.data.user.sub,
  );

  const anonymousEnv = await testEnv();
  const anonymousApp = createTestAittaDB(
    anonymousEnv,
    new MemoryAuthStore(),
    null,
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

  const anonymousRoot = await anonymousApp.fetch(
    new Request("https://aittadb.example.test/", {
      headers: { accept: "text/html" },
    }),
  );
  const anonymousRootHtml = await anonymousRoot!.text();
  assert.match(anonymousRootHtml, />Sign in to AittaDB<\/a>/);
  assert.doesNotMatch(anonymousRootHtml, />Sign out<\/a>/);
  assert.match(anonymousRootHtml, /Sign in to view your AittaDB identity/);
  assert.doesNotMatch(
    anonymousRootHtml,
    /View your AittaDB identity and open your private records and files\./,
  );

  const anonymousRootJson = (await (
    await anonymousApp.fetch(
      new Request("https://aittadb.example.test/", {
        headers: { accept: "application/json" },
      }),
    )
  )?.json()) as { actions: Array<{ name: string; href: string }> };
  assert.equal(
    anonymousRootJson.actions.find((item) => item.name === "begin-session")
      ?.href,
    "https://aittadb.example.test/session",
  );
  assert.equal(
    anonymousRootJson.actions.some((item) => item.name === "sign-out"),
    false,
  );
});

test("privacy policy provides equivalent HTML and versioned hypermedia JSON", async () => {
  const env = await testEnv({
    PRIVACY_CONTROLLER_NAME:
      'Aitta <script>alert("controller")</script> Services',
    PRIVACY_CONTACT_NAME: "Privacy Contact",
    PRIVACY_CONTACT_EMAIL: "privacy@example.test",
  });
  const app = createTestAittaDB(env, new MemoryAuthStore());

  const vendorResponse = await app.fetch(
    new Request("https://aittadb.example.test/privacy", {
      headers: {
        accept: "application/vnd.aittadb+json; version=0.1",
      },
    }),
  );
  assert.equal(vendorResponse?.status, 200);
  assert.match(
    vendorResponse?.headers.get("content-type") ?? "",
    /^application\/vnd\.aittadb\+json; version=0\.1/,
  );
  assert.equal(vendorResponse?.headers.get("aittadb-api-version"), "0.1");
  const vendorDocument = (await vendorResponse?.json()) as {
    api_version: string;
    type: string;
    id: string;
    data: {
      title: string;
      deployment: string;
      controller: Record<string, string>;
      sections: Array<{ id: string; title: string }>;
    };
    links: Array<{ rel: string[]; href: string }>;
    actions: unknown[];
  };
  assert.equal(vendorDocument.api_version, "0.1");
  assert.equal(vendorDocument.type, "privacy-policy");
  assert.equal(vendorDocument.id, "https://aittadb.example.test/privacy");
  assert.equal(vendorDocument.data.title, "Privacy Policy");
  assert.equal(vendorDocument.data.deployment, "https://aittadb.example.test");
  assert.deepEqual(vendorDocument.data.controller, {
    name: 'Aitta <script>alert("controller")</script> Services',
    contact_name: "Privacy Contact",
    email: "privacy@example.test",
  });
  assert.ok(vendorDocument.data.sections.some(({ id }) => id === "rights"));
  assert.deepEqual(vendorDocument.actions, []);
  assert.equal(
    vendorDocument.links.find(({ rel }) => rel.includes("self"))?.href,
    "https://aittadb.example.test/privacy",
  );
  assert.equal(
    vendorDocument.links.find(({ rel }) => rel.includes("contact"))?.href,
    "mailto:privacy@example.test",
  );

  const compatibleResponse = await app.fetch(
    new Request("https://aittadb.example.test/privacy", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(compatibleResponse?.status, 200);
  assert.equal(
    compatibleResponse?.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.deepEqual(await compatibleResponse?.json(), vendorDocument);

  const htmlResponse = await app.fetch(
    new Request("https://aittadb.example.test/privacy", {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(htmlResponse?.status, 200);
  assert.match(htmlResponse?.headers.get("content-type") ?? "", /^text\/html/);
  const policyHtml = await htmlResponse!.text();
  assert.match(policyHtml, /<html lang="en">/);
  assert.match(policyHtml, /<h1>Privacy Policy<\/h1>/);
  assert.match(policyHtml, /aria-label="Privacy controller and contact"/);
  assert.match(policyHtml, /aria-labelledby="privacy-rights"/);
  assert.match(policyHtml, /href="mailto:privacy@example\.test"/);
  assert.match(
    policyHtml,
    /Aitta &lt;script&gt;alert\(&quot;controller&quot;\)&lt;\/script&gt; Services/,
  );
  assert.doesNotMatch(policyHtml, /<script>/i);
  assert.match(policyHtml, /<a href="\/privacy">Privacy<\/a>/);

  const unsupported = await app.fetch(
    new Request("https://aittadb.example.test/privacy", {
      headers: { accept: "application/xml" },
    }),
  );
  assert.equal(unsupported?.status, 406);
  assert.equal(
    ((await unsupported?.json()) as { error: string }).error,
    "not_acceptable",
  );
});

test("privacy policy failures are generic and preserve HTML and JSON parity", async () => {
  const cases = [
    await testEnv(),
    await testEnv({
      PRIVACY_CONTROLLER_NAME: "AittaDB Operator",
      PRIVACY_CONTACT_EMAIL: "malformed-email",
    }),
  ];

  for (const env of cases) {
    const app = createTestAittaDB(env, new MemoryAuthStore());
    const jsonResponse = await app.fetch(
      new Request("https://aittadb.example.test/privacy", {
        headers: { accept: "application/json" },
      }),
    );
    assert.equal(jsonResponse?.status, 503);
    const jsonBody = (await jsonResponse?.json()) as {
      error: string;
      data: { error: string };
      links: Array<{ rel: string[]; href: string }>;
    };
    assert.equal(jsonBody.error, "privacy_policy_unavailable");
    assert.equal(jsonBody.data.error, "privacy_policy_unavailable");
    assert.equal(JSON.stringify(jsonBody).includes("ADMIN_SUBJECTS"), false);
    assert.equal(JSON.stringify(jsonBody).includes("malformed-email"), false);

    const htmlResponse = await app.fetch(
      new Request("https://aittadb.example.test/privacy", {
        headers: { accept: "text/html" },
      }),
    );
    assert.equal(htmlResponse?.status, 503);
    const htmlBody = await htmlResponse!.text();
    assert.match(htmlBody, /<h1>Service unavailable<\/h1>/);
    assert.match(htmlBody, /privacy_policy_unavailable/);
    assert.match(htmlBody, /<a href="\/privacy">Privacy<\/a>/);
    assert.equal(htmlBody.includes("ADMIN_SUBJECTS"), false);
    assert.equal(htmlBody.includes("malformed-email"), false);
  }
});

test("public statistics expose only the aggregate local identity count", async () => {
  const env = await testEnv();
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);

  const empty = await app.fetch(
    new Request("https://aittadb.example.test/statistics", {
      headers: { accept: "application/vnd.aittadb+json; version=0.1" },
    }),
  );
  assert.equal(empty?.status, 200);
  assert.equal(empty?.headers.get("cache-control"), "no-store");
  assert.match(
    empty?.headers.get("content-type") ?? "",
    /^application\/vnd\.aittadb\+json/,
  );
  assert.deepEqual(
    ((await empty?.json()) as { data: { identity_count: number } }).data,
    { identity_count: 0 },
  );

  await store.findOrCreateUser(
    {
      email: "first.private@example.test",
      fullName: "First Private",
      displayName: "First Private",
    },
    nowSeconds(),
  );
  await store.findOrCreateUser(
    {
      email: "second.private@example.test",
      fullName: null,
      displayName: "second.private@example.test",
    },
    nowSeconds(),
  );

  const counted = await app.fetch(
    new Request("https://aittadb.example.test/statistics", {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
    }),
  );
  const countedBody = await counted!.text();
  const countedJson = JSON.parse(countedBody) as {
    type: string;
    data: { identity_count: number };
    links: Array<{ rel: string[]; href: string }>;
    actions: unknown[];
  };
  assert.equal(countedJson.type, "service-statistics");
  assert.equal(countedJson.data.identity_count, 2);
  assert.equal(
    countedJson.links.find((item) => item.rel.includes("service"))?.href,
    "https://aittadb.example.test",
  );
  assert.deepEqual(countedJson.actions, []);
  assert.doesNotMatch(countedBody, /first\.private|second\.private|@/);

  const browser = await app.fetch(
    new Request("https://aittadb.example.test/statistics", {
      headers: { accept: "text/html", "user-agent": "curl/8.7.1" },
    }),
  );
  const browserHtml = await browser!.text();
  assert.match(browserHtml, /<h1>Service statistics<\/h1>/);
  assert.match(
    browserHtml,
    /<span>Local identities<\/span><strong>2<\/strong>/,
  );
  assert.doesNotMatch(browserHtml, /first\.private|second\.private|@/);

  const failingStore = new MemoryAuthStore();
  failingStore.countUsers = async () => {
    throw new Error("private database detail: admin@example.test");
  };
  const failingApp = createTestAittaDB(env, failingStore);
  const failed = await failingApp.fetch(
    new Request("https://aittadb.example.test/statistics", {
      headers: { accept: "application/json" },
    }),
  );
  const failedBody = await failed!.text();
  assert.equal(failed?.status, 500);
  assert.match(failedBody, /server_error/);
  assert.doesNotMatch(failedBody, /private database detail|admin@example/);
});

test("device and consent transactions negotiate equivalent hypermedia controls", async () => {
  const env = await testEnv();
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);
  const { client } = await createClientRegistration(
    {
      type: "public",
      name: "Hypermedia Client",
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["openid", "email", "profile"],
      origins: [],
    },
    store,
    nowSeconds(),
  );

  const created = await app.fetch(
    new Request("https://aittadb.example.test/oauth/device_authorization", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ client_id: client.id, scope: "openid email" }),
    }),
  );
  const createdJson = (await created?.json()) as { user_code: string };
  const entry = await app.fetch(
    new Request(
      `https://aittadb.example.test/device?user_code=${createdJson.user_code}`,
      {
        headers: {
          accept: "application/vnd.aittadb+json; version=0.1",
          "user-agent": "Mozilla/5.0",
        },
      },
    ),
  );
  const entryCsrf = cookieValue(entry!, "aittadb_csrf");
  const entryJson = (await entry?.json()) as {
    type: string;
    data: { user_code: string };
    actions: Array<{
      name: string;
      method: string;
      fields: Array<{ name: string; value?: unknown; secret?: boolean }>;
    }>;
  };
  assert.equal(entryJson.type, "device-code-entry");
  assert.equal(entryJson.data.user_code, createdJson.user_code);
  const reviewAction = entryJson.actions.find(
    (candidate) => candidate.name === "review-device-request",
  );
  assert.equal(reviewAction?.method, "POST");
  assert.equal(
    reviewAction?.fields.find((candidate) => candidate.name === "csrf_token")
      ?.secret,
    true,
  );

  const review = await app.fetch(
    new Request("https://aittadb.example.test/device", {
      method: "POST",
      headers: {
        accept: "application/vnd.aittadb+json; version=0.1",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${entryCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        csrf_token: entryCsrf,
        user_code: createdJson.user_code,
      }),
    }),
  );
  const reviewCsrf = cookieValue(review!, "aittadb_csrf");
  const reviewJson = (await review?.json()) as {
    type: string;
    data: { client_name: string; scopes: string[]; status: string };
    actions: Array<{
      name: string;
      fields: Array<{ name: string; value?: unknown }>;
    }>;
  };
  assert.equal(reviewJson.type, "device-request");
  assert.equal(reviewJson.data.client_name, "Hypermedia Client");
  assert.deepEqual(reviewJson.data.scopes, ["openid", "email"]);
  assert.equal(reviewJson.data.status, "pending");
  assert.deepEqual(
    reviewJson.actions.map((candidate) => candidate.name),
    ["approve-device-request", "deny-device-request"],
  );

  const denied = await app.fetch(
    new Request("https://aittadb.example.test/device/decision", {
      method: "POST",
      headers: {
        accept: "application/vnd.aittadb+json; version=0.1",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${reviewCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        csrf_token: reviewCsrf,
        user_code: createdJson.user_code,
        decision: "deny",
      }),
    }),
  );
  assert.deepEqual(
    ((await denied?.json()) as { data: { status: string }; actions: unknown[] })
      .data,
    { status: "denied" },
  );

  const verifier = "transaction-verifier-value-with-more-than-43-characters";
  const authorize = await app.fetch(
    new Request(
      `https://aittadb.example.test/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client.id,
        redirect_uri: "https://client.example.test/callback",
        scope: "openid email",
        state: "transaction-state",
        code_challenge: await sha256(verifier),
        code_challenge_method: "S256",
      })}`,
    ),
  );
  const consentLocation = authorize?.headers.get("location") ?? "";
  const consent = await app.fetch(
    new Request(consentLocation, {
      headers: { accept: "application/vnd.aittadb+json; version=0.1" },
    }),
  );
  const consentJson = (await consent?.json()) as {
    type: string;
    data: { client_name: string; scopes: string[]; status: string };
    actions: Array<{ name: string; method: string }>;
  };
  assert.equal(consentJson.type, "authorization-consent");
  assert.equal(consentJson.data.client_name, "Hypermedia Client");
  assert.deepEqual(consentJson.data.scopes, ["openid", "email"]);
  assert.equal(consentJson.data.status, "pending");
  assert.deepEqual(
    consentJson.actions.map((candidate) => candidate.name),
    ["approve-authorization", "deny-authorization"],
  );

  const anonymousEnv = await testEnv();
  const anonymousApp = createTestAittaDB(anonymousEnv, store, null);
  const anonymousConsent = await anonymousApp.fetch(
    new Request(consentLocation, { headers: { accept: "application/json" } }),
  );
  const anonymousConsentJson = (await anonymousConsent?.json()) as {
    error: string;
    actions: Array<{ name: string; href: string }>;
  };
  assert.equal(anonymousConsent?.status, 401);
  assert.equal(anonymousConsentJson.error, "login_required");
  assert.match(
    anonymousConsentJson.actions[0]?.href ?? "",
    /^https:\/\/aittadb\.example\.test\/signin-with-chatgpt\?return_to=/,
  );
});

test("browser protocol representations execute real device, token, UserInfo, introspection, and revocation operations", async () => {
  const env = await testEnv({ DEVICE_POLL_INTERVAL_SECONDS: "1" });
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);
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
      { headers: { accept: "text/html" } },
    ),
  );
  const entryCsrf = cookieValue(entry!, "aittadb_csrf");
  const review = await app.fetch(
    new Request("https://aittadb.example.test/device", {
      method: "POST",
      headers: {
        accept: "text/html",
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
        accept: "text/html",
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
  const tokenFormHtml = await tokenForm!.text();
  assert.match(tokenFormHtml, /<h1>Token exchange<\/h1>/);
  assert.match(tokenFormHtml, /data-conditional-form/);
  assert.match(tokenFormHtml, /data-show-when="grant_type:authorization_code"/);
  assert.match(tokenFormHtml, /data-show-when="grant_type:refresh_token"/);
  assert.match(tokenFormHtml, /src="\/auth-ui\.js" defer/);
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
  assert.match(tokenResultHtml, /AittaDB-issued credentials are ready\./);
  assert.doesNotMatch(tokenResultHtml, /Independent AittaDB credentials/i);
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
        client_id: client.id,
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
  assert.match(
    await wrongOrigin!.text(),
    /Same-origin form submission is required/,
  );

  const apiGetToken = await app.fetch(
    new Request("https://aittadb.example.test/oauth/token", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(apiGetToken?.status, 200);
  const tokenEndpointDocument = (await apiGetToken?.json()) as {
    type: string;
    actions: Array<{ name: string; method: string; fields: unknown[] }>;
  };
  assert.equal(tokenEndpointDocument.type, "token-endpoint");
  assert.equal(
    tokenEndpointDocument.actions.find(
      (candidate) => candidate.name === "exchange-oauth-grant",
    )?.method,
    "POST",
  );
});

test("device flow succeeds with local UUID subject, ID token, refresh token, UserInfo, introspection, and revocation", async () => {
  const env = await testEnv({ DEVICE_POLL_INTERVAL_SECONDS: "1" });
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);
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
    links: Array<{ rel: string[]; href: string }>;
    actions: Array<{ name: string; method: string }>;
  };
  assert.equal(
    deviceJson.links.find((item) => item.rel.includes("verification"))?.href,
    "https://aittadb.example.test/device",
  );
  assert.equal(
    deviceJson.actions.find((item) => item.name === "poll-device-token")
      ?.method,
    "POST",
  );
  assert.equal(Array.from(store.devices.values())[0]?.userCodeDisplay, "");

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
    links: Array<{ rel: string[]; href: string }>;
    actions: unknown[];
  };
  assert.equal(pendingJson.error, "authorization_pending");
  assert.equal(
    pendingJson.links.find((item) => item.rel.includes("documentation"))?.href,
    "/docs",
  );
  assert.deepEqual(pendingJson.actions, []);

  const entry = await app.fetch(
    new Request(
      `https://aittadb.example.test/device?user_code=${deviceJson.user_code}`,
      { headers: { accept: "text/html" } },
    ),
  );
  assert.match(await entry!.text(), /A short code connects two moments/);
  const csrf = cookieValue(entry!, "aittadb_csrf");
  const continueResponse = await app.fetch(
    new Request("https://aittadb.example.test/device", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${csrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({ csrf_token: csrf, user_code: deviceJson.user_code }),
    }),
  );
  const consentHtml = await continueResponse!.text();
  assert.match(consentHtml, /Match the request before the exchange/);
  assert.match(consentHtml, new RegExp(deviceJson.user_code));
  const decisionCsrf = cookieValue(continueResponse!, "aittadb_csrf");
  const approved = await app.fetch(
    new Request("https://aittadb.example.test/device/decision", {
      method: "POST",
      headers: {
        accept: "text/html",
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
      { headers: { accept: "text/html" } },
    ),
  );
  const deniedEntryCsrf = cookieValue(deniedEntry!, "aittadb_csrf");
  const deniedReview = await app.fetch(
    new Request("https://aittadb.example.test/device", {
      method: "POST",
      headers: {
        accept: "text/html",
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
        accept: "text/html",
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
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);
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
  const consent = await app.fetch(
    new Request(consentLocation, { headers: { accept: "text/html" } }),
  );
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
  const tokenJson = (await token?.json()) as {
    access_token: string;
    id_token: string;
  };
  assert.ok(tokenJson.access_token);
  assert.ok(tokenJson.id_token);
  const verifiedIdToken = await verifyJwt(
    tokenJson.id_token,
    [publicJwk(config.jwtPrivateJwk, config.jwtKeyId)],
    {
      issuer: config.issuerUrl,
      audience: client.id,
      now: nowSeconds(),
    },
  );
  assert.equal(verifiedIdToken.claims.aud, client.id);
  assert.equal(verifiedIdToken.claims.nonce, "n");
  assert.equal(verifiedIdToken.claims.token_use, "id");

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
  const app = createTestAittaDB(env, store);
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
    data: { key: string; value: { theme: string; count: number } };
    links: Array<{ rel: string[]; href: string }>;
    actions: Array<{ name: string; method: string }>;
  };
  assert.equal(recordPutJson.data.key, "app/settings");
  assert.equal(recordPutJson.data.value.theme, "midnight");
  assert.equal(
    recordPutJson.links.find((item) => item.rel.includes("self"))?.href,
    "https://aittadb.example.test/storage/records/app/settings",
  );
  assert.equal(
    recordPutJson.actions.find((item) => item.name === "replace-record")
      ?.method,
    "PUT",
  );

  const recordList = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  );
  const recordListJson = (await recordList?.json()) as {
    data: { items: Array<{ data: { key: string } }> };
    actions: Array<{ name: string; href: string; templated?: boolean }>;
  };
  assert.deepEqual(
    recordListJson.data.items.map((record) => record.data.key),
    ["app/settings"],
  );
  assert.equal(
    recordListJson.actions.find(
      (item) => item.name === "create-or-replace-record",
    )?.href,
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

  const fileCreate = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
      method: "POST",
      headers: {
        accept: "application/vnd.aittadb+json; version=0.1",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/pdf",
      },
      body: "new file bytes",
    }),
  );
  assert.equal(fileCreate?.status, 201);
  const fileCreateJson = (await fileCreate?.json()) as {
    data: { key: string; content_type: string; size: number };
    actions: Array<{ name: string; method: string }>;
  };
  assert.match(fileCreateJson.data.key, /^[0-9a-f-]{36}$/);
  assert.equal(fileCreateJson.data.content_type, "application/pdf");
  assert.equal(fileCreateJson.data.size, 14);
  assert.equal(
    fileCreate?.headers.get("location"),
    `https://aittadb.example.test/storage/files/${fileCreateJson.data.key}`,
  );
  assert.equal(
    fileCreateJson.actions.find((item) => item.name === "replace-file")?.method,
    "PUT",
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
    data: {
      key: string;
      content_type: string;
      size: number;
      sha256: string;
    };
  };
  assert.equal(filePutJson.data.key, "notes/hello.txt");
  assert.equal(filePutJson.data.content_type, "text/plain");
  assert.equal(filePutJson.data.size, 13);
  assert.ok(filePutJson.data.sha256);

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
  const listedFileKeys = (
    (await fileList?.json()) as {
      data: { items: Array<{ data: { key: string } }> };
      actions: Array<{ name: string; method: string }>;
    }
  ).data.items.map((file) => file.data.key);
  assert.deepEqual(listedFileKeys, [
    fileCreateJson.data.key,
    "notes/hello.txt",
  ]);

  const deleteRecord = await app.fetch(
    new Request("https://aittadb.example.test/storage/records/app/settings", {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  );
  assert.equal(
    ((await deleteRecord?.json()) as { data: { deleted: boolean } }).data
      .deleted,
    true,
  );

  const deleteFile = await app.fetch(
    new Request("https://aittadb.example.test/storage/files/notes/hello.txt", {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  );
  assert.equal(
    ((await deleteFile?.json()) as { data: { deleted: boolean } }).data.deleted,
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
  const adminSubject = crypto.randomUUID();
  const env = await testEnv({ ADMIN_SUBJECTS: adminSubject });
  const privateJwk = JSON.parse(String(env.JWT_PRIVATE_JWK)) as JsonWebKey;
  assert.equal(typeof privateJwk.d, "string");
  const privateScalar = String(privateJwk.d);
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);
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
  const ownerRecordData = ownerRecordPayload.data as Record<string, unknown>;
  assert.equal(ownerRecordData.key, "oauth_clients");
  assert.equal(Object.hasOwn(ownerRecordData, "userId"), false);
  assert.equal(Object.hasOwn(ownerRecordData, "clientId"), false);

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
  const ownerFileData = ownerFilePayload.data as Record<string, unknown>;
  assert.equal(Object.hasOwn(ownerFileData, "r2Key"), false);
  assert.equal(Object.hasOwn(ownerFileData, "userId"), false);
  assert.equal(Object.hasOwn(ownerFileData, "clientId"), false);
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
      ((await outsiderRecords?.json()) as { data: { items: unknown[] } }).data
        .items,
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
      ((await ownerRecordAfterDelete?.json()) as { data: { value: unknown } })
        .data.value,
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
      ((await ownerRecordAfterWrite?.json()) as { data: { value: unknown } })
        .data.value,
      { namespace: "application-owned" },
    );

    const outsiderFiles = await app.fetch(
      new Request("https://aittadb.example.test/storage/files", {
        headers: outsiderHeaders,
      }),
    );
    assert.deepEqual(
      ((await outsiderFiles?.json()) as { data: { items: unknown[] } }).data
        .items,
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
    assert.equal(body?.includes(adminSubject), false);
    assert.equal(body?.includes(ownerFile.r2Key), false);
    assert.equal(body?.includes("JWT_PRIVATE_JWK"), false);
    assert.equal(body?.includes("ADMIN_SUBJECTS"), false);
  }
});

test("browser storage representations execute real scoped D1 and R2 operations", async () => {
  const env = await testEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);
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
  assert.doesNotMatch(recordFormHtml, /name="operation"/);
  assert.match(recordFormHtml, /No records found\./);
  assert.match(recordFormHtml, /Open or create one record/);
  assert.match(recordFormHtml, /Continue to record endpoint/);
  assert.match(
    recordFormHtml,
    /data-key-action-template="\/storage\/records\/{key}"/,
  );

  const noScriptNavigation = await app.fetch(
    new Request(
      "https://aittadb.example.test/storage/records?key=browser%2Fsettings",
      { headers: { accept: "text/html" } },
    ),
  );
  assert.equal(noScriptNavigation?.status, 303);
  assert.equal(
    noScriptNavigation?.headers.get("location"),
    "/storage/records/browser/settings",
  );

  const writeRecord = await app.fetch(
    new Request(
      "https://aittadb.example.test/storage/records/browser/settings",
      {
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
          _method: "PUT",
          auth_mode: "token",
          access_token: accessToken,
          value: JSON.stringify({ theme: "teal", count: 2 }),
        }),
      },
    ),
  );
  const writeRecordHtml = await writeRecord!.text();
  assert.equal(writeRecord?.status, 200);
  assert.match(writeRecordHtml, /<h1>JSON record storage<\/h1>/);
  assert.match(
    writeRecordHtml,
    /<h2 id="record-details-heading">Record details<\/h2>/,
  );
  assert.match(writeRecordHtml, /<h3>Update record<\/h3>/);
  assert.match(writeRecordHtml, /browser\/settings/);
  assert.doesNotMatch(
    writeRecordHtml,
    new RegExp(accessToken.replaceAll(".", "\\.")),
  );

  const readRecord = await app.fetch(
    new Request(
      "https://aittadb.example.test/storage/records/browser/settings",
      {
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
          _method: "GET",
          auth_mode: "token",
          access_token: accessToken,
        }),
      },
    ),
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
        _method: "GET",
        auth_mode: "token",
        access_token: accessToken,
      }),
    }),
  );
  const listRecordsHtml = await listRecords!.text();
  assert.match(listRecordsHtml, /<table class="resource-table">/);
  assert.match(listRecordsHtml, /browser\/settings/);
  assert.doesNotMatch(listRecordsHtml, /Storage operation result/);

  const invalidCollectionAction = await app.fetch(
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
        _method: "DELETE",
        auth_mode: "token",
        access_token: accessToken,
      }),
    }),
  );
  assert.equal(invalidCollectionAction?.status, 400);
  assert.match(
    await invalidCollectionAction!.text(),
    /does not match the JSON storage resource URL/,
  );

  const itemForm = await app.fetch(
    new Request(
      "https://aittadb.example.test/storage/records/browser/settings",
      { headers: { accept: "text/html" } },
    ),
  );
  const itemFormHtml = await itemForm!.text();
  assert.equal(
    (
      itemFormHtml.match(/action="\/storage\/records\/browser\/settings"/g) ??
      []
    ).length,
    1,
  );
  assert.doesNotMatch(itemFormHtml, /name="key"/);
  assert.doesNotMatch(itemFormHtml, /name="operation"/);
  assert.match(itemFormHtml, /name="_method" value="PUT"/);
  assert.doesNotMatch(itemFormHtml, /name="_method" value="GET"/);
  assert.doesNotMatch(itemFormHtml, /name="_method" value="DELETE"/);
  assert.match(itemFormHtml, /Storage request failed/);
  assert.match(itemFormHtml, /<h3>Create record<\/h3>/);

  const fileForm = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
      headers: {
        accept: "text/html",
        cookie: `aittadb_csrf=${recordCsrf}`,
      },
    }),
  );
  const fileCsrf = cookieValue(fileForm!, "aittadb_csrf");
  assert.equal(fileCsrf, recordCsrf);
  const fileFormHtml = await fileForm!.text();
  assert.match(fileFormHtml, /<h1>File object storage<\/h1>/);
  assert.match(fileFormHtml, /No files found\./);
  assert.match(fileFormHtml, /Open or upload one file/);
  assert.match(fileFormHtml, /Continue to file endpoint/);
  assert.match(fileFormHtml, /<h3>Upload new file<\/h3>/);
  assert.match(fileFormHtml, /action="\/storage\/files"/);
  assert.match(fileFormHtml, /name="_method" value="POST"/);
  assert.match(fileFormHtml, /enctype="multipart\/form-data"/);
  assert.match(fileFormHtml, /data-file-drop-zone/);
  assert.match(fileFormHtml, /<label for="files_create_file">File /);
  assert.match(
    fileFormHtml,
    /<input id="files_create_file" name="file" type="file" aria-describedby="files_create_file_status" required>/,
  );
  assert.match(fileFormHtml, /Choose a file, or drag and drop it here\./);
  assert.doesNotMatch(fileFormHtml, /name="operation"/);
  assert.match(
    fileFormHtml,
    /data-key-action-template="\/storage\/files\/{key}"/,
  );

  const collectionUploadForm = new FormData();
  collectionUploadForm.set("ui", "1");
  collectionUploadForm.set("csrf_token", fileCsrf);
  collectionUploadForm.set("_method", "POST");
  collectionUploadForm.set("auth_mode", "token");
  collectionUploadForm.set("access_token", accessToken);
  collectionUploadForm.set(
    "file",
    new File(["collection upload"], "collection.txt", {
      type: "text/plain",
    }),
  );
  const collectionUpload = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
      method: "POST",
      headers: {
        accept: "text/html",
        cookie: `aittadb_csrf=${fileCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: collectionUploadForm,
    }),
  );
  assert.equal(collectionUpload?.status, 201);
  const collectionLocation = collectionUpload?.headers.get("location") ?? "";
  assert.match(
    collectionLocation,
    /^https:\/\/aittadb\.example\.test\/storage\/files\/[0-9a-f-]{36}$/,
  );
  const collectionUploadHtml = await collectionUpload!.text();
  assert.match(collectionUploadHtml, /<h2 id="file-details-heading">/);
  assert.match(collectionUploadHtml, /<h3>Update file<\/h3>/);

  const uploadForm = new FormData();
  uploadForm.set("ui", "1");
  uploadForm.set("csrf_token", fileCsrf);
  uploadForm.set("_method", "PUT");
  uploadForm.set("auth_mode", "token");
  uploadForm.set("access_token", accessToken);
  uploadForm.set(
    "file",
    new File(["hello from browser storage"], "hello.txt", {
      type: "text/plain",
    }),
  );
  const uploadFile = await app.fetch(
    new Request(
      "https://aittadb.example.test/storage/files/browser/hello.txt",
      {
        method: "POST",
        headers: {
          accept: "text/html",
          cookie: `aittadb_csrf=${fileCsrf}`,
          origin: "https://aittadb.example.test",
        },
        body: uploadForm,
      },
    ),
  );
  assert.equal(uploadFile?.status, 200);
  const uploadFileHtml = await uploadFile!.text();
  assert.match(uploadFileHtml, /<h1>File object storage<\/h1>/);
  assert.match(
    uploadFileHtml,
    /<h2 id="file-details-heading">File details<\/h2>/,
  );
  assert.match(uploadFileHtml, /<h3>Update file<\/h3>/);
  assert.match(uploadFileHtml, /browser\/hello\.txt/);
  assert.doesNotMatch(uploadFileHtml, /File operation result/);

  const listFiles = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${fileCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: form({
        ui: "1",
        csrf_token: fileCsrf,
        _method: "GET",
        auth_mode: "token",
        access_token: accessToken,
      }),
    }),
  );
  const listFilesHtml = await listFiles!.text();
  assert.match(listFilesHtml, /<table class="resource-table">/);
  assert.match(listFilesHtml, /browser\/hello\.txt/);
  assert.match(listFilesHtml, /text\/plain/);

  const downloadFile = await app.fetch(
    new Request(
      "https://aittadb.example.test/storage/files/browser/hello.txt",
      {
        method: "POST",
        headers: {
          accept: "text/html",
          "content-type": "application/x-www-form-urlencoded",
          cookie: `aittadb_csrf=${fileCsrf}`,
          origin: "https://aittadb.example.test",
        },
        body: form({
          ui: "1",
          csrf_token: fileCsrf,
          _method: "GET",
          auth_mode: "token",
          access_token: accessToken,
        }),
      },
    ),
  );
  assert.equal(downloadFile?.headers.get("content-type"), "text/plain");
  assert.match(
    downloadFile?.headers.get("content-disposition") ?? "",
    /filename\*=UTF-8''hello\.txt/,
  );
  assert.equal(await downloadFile!.text(), "hello from browser storage");

  const deleteFile = await app.fetch(
    new Request(
      "https://aittadb.example.test/storage/files/browser/hello.txt",
      {
        method: "POST",
        headers: {
          accept: "text/html",
          "content-type": "application/x-www-form-urlencoded",
          cookie: `aittadb_csrf=${fileCsrf}`,
          origin: "https://aittadb.example.test",
        },
        body: form({
          ui: "1",
          csrf_token: fileCsrf,
          _method: "DELETE",
          auth_mode: "token",
          access_token: accessToken,
        }),
      },
    ),
  );
  const deleteFileHtml = await deleteFile!.text();
  assert.match(deleteFileHtml, /<h2>File deleted<\/h2>/);
  assert.match(deleteFileHtml, /No file remains at the logical key/);
  assert.doesNotMatch(deleteFileHtml, /&quot;deleted&quot;/);

  const deleteRecord = await app.fetch(
    new Request(
      "https://aittadb.example.test/storage/records/browser/settings",
      {
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
          _method: "DELETE",
          auth_mode: "token",
          access_token: accessToken,
        }),
      },
    ),
  );
  const deleteRecordHtml = await deleteRecord!.text();
  assert.match(deleteRecordHtml, /<h2>Record deleted<\/h2>/);
  assert.doesNotMatch(deleteRecordHtml, /&quot;deleted&quot;/);

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
    new Request(
      "https://aittadb.example.test/storage/records/browser/too-large",
      {
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
          _method: "PUT",
          auth_mode: "token",
          access_token: accessToken,
          value: JSON.stringify("x".repeat(65_536)),
        }),
      },
    ),
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
        _method: "GET",
        auth_mode: "token",
        access_token: accessToken,
      }),
    }),
  );
  assert.equal(missingCsrf?.status, 403);
  assert.match(await missingCsrf!.text(), /CSRF validation failed/);

  const oversizedMultipart = await app.fetch(
    new Request(
      "https://aittadb.example.test/storage/files/browser/too-large.bin",
      {
        method: "POST",
        headers: {
          accept: "text/html",
          "content-type": "multipart/form-data; boundary=oversized",
          "content-length": String(11 * 1024 * 1024),
          origin: "https://aittadb.example.test",
        },
        body: "--oversized--\r\n",
      },
    ),
  );
  assert.equal(oversizedMultipart?.status, 413);
});

test("current signed-in session drives UserInfo and isolated record and file operations", async () => {
  const env = await testEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);

  const recordForm = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      headers: { accept: "text/html" },
    }),
  );
  const recordCsrf = cookieValue(recordForm!, "aittadb_csrf");
  const recordHtml = await recordForm!.text();
  assert.match(recordHtml, /option value="session" selected/);
  assert.match(recordHtml, /Current signed-in session/);
  assert.match(recordHtml, /durable private AittaDB namespace/);

  const sessionWrite = await app.fetch(
    new Request(
      "https://aittadb.example.test/storage/records/current/preferences",
      {
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
          _method: "PUT",
          value: JSON.stringify({ density: "compact" }),
        }),
      },
    ),
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
    ((await applicationRecords!.json()) as { data: { items: unknown[] } }).data
      .items,
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
  upload.set("_method", "PUT");
  upload.set(
    "file",
    new File(["session-owned"], "note.txt", { type: "text/plain" }),
  );
  const sessionUpload = await app.fetch(
    new Request("https://aittadb.example.test/storage/files/current/note.txt", {
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
    ((await applicationFiles!.json()) as { data: { items: unknown[] } }).data
      .items,
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

  const signedOutEnv = await testEnv();
  const signedOutApp = createTestAittaDB(
    signedOutEnv,
    new MemoryAuthStore(),
    null,
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
        _method: "GET",
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
  const baseEnv = await testEnv();
  const store = new MemoryAuthStore();
  const adminIdentity = {
    email: "admin@example.test",
    fullName: "AittaDB Admin",
    displayName: "AittaDB Admin",
  };
  const adminUser = await store.findOrCreateUser(adminIdentity, nowSeconds());
  const env = {
    ...baseEnv,
    ADMIN_SUBJECTS: adminUser.id,
    FEATURE_OAUTH_APPS_ENABLED: "true",
  };
  const app = createTestAittaDB(env, store, adminIdentity);
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
      headers: {
        accept: "text/html",
      },
    }),
  );
  const adminCsrf = cookieValue(admin!, "aittadb_csrf");
  const adminHtml = await admin!.text();
  const adminSubmission = adminHtml.match(
    /name="submission_token" value="([^"]+)"/,
  )?.[1];
  assert.match(adminSubmission ?? "", /^[A-Za-z0-9_-]{32}$/);
  assert.equal(adminHtml.includes(BROWSER_SESSION_CLIENT_ID), false);
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
        submission_token: adminSubmission!,
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
