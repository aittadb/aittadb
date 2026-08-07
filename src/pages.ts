import type {
  AuthorizationRequest,
  ClientView,
  DeviceGrant,
  LocalUser,
} from "./types";

export interface PageAction {
  href: string;
  label: string;
  secondary?: boolean;
}

export interface PageOptions {
  title: string;
  eyebrow?: string;
  heading: string;
  summary?: string;
  visualEyebrow?: string;
  visualHeading?: string;
  visualSummary?: string;
  body: string;
  actions?: readonly PageAction[];
  tone?: "default" | "success" | "warning" | "danger";
  status?: number;
  statusLabel?: string;
  social?: {
    description: string;
    imageUrl: string;
    url: string;
  };
  layout?: "default" | "docs";
  head?: string;
  scripts?: string;
}

export function serviceHomePage(metadata: {
  service: string;
  description: string;
  hostingPlatform: string;
  issuer: string;
  docs: string;
  openapi: string;
  officialOpenAIProduct: boolean;
  upstreamSignIn: {
    source: string;
    identitySignal: string;
    stableSubjectSupplied: boolean;
    credentialsForwarded: boolean;
  };
  sessionIssuer: string;
  capabilities: readonly string[];
  plannedCapabilities: readonly string[];
  _links?: Record<string, { href: string; type?: string }>;
  actions?: Record<string, unknown>;
}): string {
  return pageDocument({
    title: metadata.service,
    eyebrow: "Hosted application backend",
    heading: metadata.service,
    summary: metadata.description,
    visualEyebrow: "ChatGPT sign-in boundary",
    visualHeading: "One hosted backend for sign-in, data, and files.",
    visualSummary:
      "Third-party apps use AittaDB for identity, sessions, isolated JSON records, and file storage while ChatGPT credentials stay inside Sites.",
    social: {
      description: metadata.description,
      imageUrl: `${metadata.issuer}/og.png`,
      url: metadata.issuer,
    },
    body: `<section class="info-grid" aria-label="Service metadata"><div><span>Hosting platform</span><strong>${escapeHtml(metadata.hostingPlatform)}</strong></div><div><span>Service and issuer URL</span><code>${escapeHtml(metadata.issuer)}</code></div><div><span>Session issuer</span><strong>${escapeHtml(metadata.sessionIssuer)} only</strong></div><div><span>Persistent storage</span><strong>D1 records + R2 files</strong></div></section><p class="note"><strong>AittaDB is deployed as an application on OpenAI-hosted ChatGPT Sites.</strong> The Sites platform provides its managed runtime, ChatGPT sign-in, D1, R2, configuration, and secrets. Third-party apps, services, and agents use AittaDB's HTTP APIs for identity, sessions, persistent JSON records, and files. Persistent events are planned and are not available in the current MVP.</p><p class="note"><strong>ChatGPT supplies browser sign-in inside ChatGPT Sites.</strong> AittaDB creates a separate local UUID and issues its own OAuth, OIDC, and JWT credentials. It never forwards ChatGPT credentials, and its credentials and stored data are not OpenAI or ChatGPT credentials or data. AittaDB itself is independent and is not affiliated with, endorsed by, or an official product of OpenAI.</p><section aria-labelledby="operations-heading"><h2 id="operations-heading">Available operations</h2><div class="operation-grid"><a href="/session"><strong>My AittaDB</strong><span>Sign in to view your AittaDB identity and reach your private records and files.</span></a><a href="/storage/records"><strong>JSON records</strong><span>Create, read, list, and delete persistent D1-backed values.</span></a><a href="/storage/files"><strong>File storage</strong><span>Upload, list, download, and delete files stored through D1 and R2.</span></a><a href="/admin/clients"><strong>Application clients</strong><span>Register and manage OAuth clients when the signed-in email is allowlisted.</span></a></div></section>`,
    actions: [
      { href: "/session", label: "Sign in to AittaDB" },
      { href: "/docs", label: "API docs", secondary: true },
      {
        href: "/openapi.json?format=json",
        label: "OpenAPI JSON",
        secondary: true,
      },
      { href: "/health", label: "Health", secondary: true },
    ],
  });
}

export function sessionPage(user: LocalUser): string {
  return pageDocument({
    title: "My AittaDB session",
    eyebrow: "Authenticated identity",
    heading: "My AittaDB session",
    summary:
      "Use the AittaDB identity created from your ChatGPT sign-in to access private data or approve a registered application's request.",
    visualEyebrow: "Identity boundary",
    visualHeading: "Your AittaDB identity, records, and files.",
    visualSummary:
      "ChatGPT establishes the upstream sign-in. AittaDB uses its own immutable user ID for sessions and persistent storage.",
    body: `<section class="info-grid" aria-label="Authenticated AittaDB identity"><div><span>Display name</span><strong>${escapeHtml(user.displayName)}</strong></div><div><span>Email signal</span><strong>${escapeHtml(user.email)}</strong></div><div><span>AittaDB subject</span><code>${escapeHtml(user.id)}</code></div><div><span>Identity created</span><time datetime="${new Date(user.createdAt * 1000).toISOString()}">${escapeHtml(new Date(user.createdAt * 1000).toISOString())}</time></div></section><p class="note">This local subject is the immutable <code>sub</code> used in AittaDB-issued sessions. Your current sign-in can access its own persistent AittaDB namespace and identity claims. Third-party OAuth clients remain separate and still require registered client details, explicit consent, and local scopes.</p><section aria-labelledby="session-operations-heading"><h2 id="session-operations-heading">Available operations</h2><div class="operation-grid"><a href="/storage/records"><strong>My JSON records</strong><span>Use this identity's isolated D1 records, or test an explicit client token.</span></a><a href="/storage/files"><strong>My files</strong><span>Use this identity's isolated R2 files, or test an explicit client token.</span></a><a href="/userinfo"><strong>My identity claims</strong><span>Read this session's claims, or inspect an explicit client access token.</span></a><a href="/admin/clients"><strong>Application clients</strong><span>Manage OAuth clients only when this signed-in email is allowlisted.</span></a></div></section>`,
    actions: [
      { href: "/storage/records", label: "Open my records" },
      { href: "/storage/files", label: "Open my files", secondary: true },
      {
        href: "/signout-with-chatgpt?return_to=%2F",
        label: "Sign out",
        secondary: true,
      },
      { href: "/", label: "Service home", secondary: true },
    ],
  });
}

export function healthPage(status: {
  ok: boolean;
  service: string;
  d1: boolean;
  r2?: boolean;
  _links?: Record<string, { href: string; type?: string }>;
}): string {
  return pageDocument({
    title: "Service health",
    eyebrow: "Runtime status",
    heading: "Service health",
    summary: status.ok
      ? "AittaDB is reachable and ready to answer requests."
      : "AittaDB is reachable but one or more dependencies are unavailable.",
    tone: status.ok ? "success" : "danger",
    visualEyebrow: "Runtime map",
    visualHeading: status.ok
      ? "Every service, accounted for."
      : "One or more layers need attention.",
    visualSummary:
      "AittaDB reports its durable data and object-storage bindings without exposing operational secrets.",
    body: `<section class="info-grid" aria-label="Health checks"><div><span>Status</span><strong>${status.ok ? "ok" : "unavailable"}</strong></div><div><span>Service</span><code>${escapeHtml(status.service)}</code></div><div><span>D1 binding</span><strong>${status.d1 ? "available" : "unavailable"}</strong></div><div><span>R2 binding</span><strong>${status.r2 ? "available" : "unavailable"}</strong></div></section>`,
    actions: [
      { href: "/", label: "Service" },
      { href: "/docs", label: "API docs", secondary: true },
    ],
  });
}

export function docsPage(): string {
  return pageDocument({
    title: "AittaDB API",
    eyebrow: "API reference",
    heading: "AittaDB API",
    summary:
      "Interactive OpenAPI reference for AittaDB identity, sessions, JSON records, file storage, and administration.",
    visualEyebrow: "Application backend API",
    visualHeading: "Build against the real AittaDB service.",
    visualSummary:
      "Discovery, authorization, credentials, records, and files are available through documented production endpoints.",
    body: `<p class="note">This self-hosted Swagger UI reads the canonical OpenAPI 3.1 document from <code>/openapi.json</code>. "Try it out" calls the real AittaDB routes on this origin. Credentials entered here are sent only in the selected request and are not retained by AittaDB browser state.</p><div id="swagger-ui" aria-label="Interactive AittaDB OpenAPI documentation"><p>Loading API reference...</p></div><noscript><p class="notice">The interactive API reference requires JavaScript. The canonical OpenAPI JSON remains available below.</p></noscript>`,
    actions: [
      { href: "/openapi.json?format=json", label: "OpenAPI JSON" },
      { href: "/", label: "Service", secondary: true },
    ],
    layout: "docs",
    head: `<link rel="stylesheet" href="/vendor/swagger-ui/swagger-ui.css">`,
    scripts: `<script src="/vendor/swagger-ui/swagger-ui-bundle.js" defer></script><script src="/swagger-ui/aittadb-swagger.js" defer></script>`,
  });
}

export function deviceEntryPage(
  userCode: string,
  csrf: string,
  error = "",
): string {
  return pageDocument({
    title: "Enter device code",
    eyebrow: "Device authorization",
    heading: "Enter device code",
    summary:
      "Type the code shown by your CLI to review the local scopes requested by that client.",
    visualEyebrow: "Device handoff",
    visualHeading: "A short code connects two moments.",
    visualSummary:
      "The browser confirms the request while the original device keeps polling through the standard device flow.",
    tone: error ? "warning" : "default",
    body: `${error ? alertMessage(error) : ""}<form method="post" action="/device"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label for="user_code">User code</label><input id="user_code" name="user_code" autocomplete="one-time-code" value="${escapeHtml(userCode)}" required><div class="actions"><button type="submit">Continue</button></div></form>`,
  });
}

export function deviceConsentPage(
  grant: DeviceGrant,
  client: ClientView,
  csrf: string,
): string {
  return pageDocument({
    title: "Approve device",
    eyebrow: "Device authorization",
    heading: "Approve device request",
    summary:
      "Approve only if the user code and client name match the application you started.",
    visualEyebrow: "Device handoff",
    visualHeading: "Match the request before the exchange.",
    visualSummary:
      "Approval creates AittaDB credentials for this client only. The upstream ChatGPT credential never leaves the Sites boundary.",
    body: `<section class="info-grid" aria-label="Device request"><div><span>Client</span><strong>${escapeHtml(client.name)}</strong></div><div><span>User code</span><strong>${escapeHtml(grant.userCodeDisplay)}</strong></div><div><span>Local scopes</span><code>${escapeHtml(grant.scope)}</code></div></section><form method="post" action="/device/decision"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="user_code" value="${escapeHtml(grant.userCodeDisplay)}"><div class="actions"><button name="decision" value="approve" type="submit">Approve with current session</button><button class="secondary" name="decision" value="deny" type="submit">Deny</button></div></form>`,
  });
}

export function consentPage(
  request: AuthorizationRequest,
  client: ClientView,
  csrf: string,
): string {
  return pageDocument({
    title: "Approve application",
    eyebrow: "OAuth consent",
    heading: "Approve application",
    summary:
      "This grants the client local AittaDB scopes. It does not grant access to ChatGPT or OpenAI data.",
    visualEyebrow: "Permission boundary",
    visualHeading: "Scope stays visible and explicit.",
    visualSummary:
      "Only the listed local permissions cross this boundary, and only after you approve the registered client.",
    body: `<section class="info-grid" aria-label="Authorization request"><div><span>Client</span><strong>${escapeHtml(client.name)}</strong></div><div><span>Local scopes</span><code>${escapeHtml(request.scope)}</code></div><div><span>Redirect URI</span><code>${escapeHtml(request.redirectUri)}</code></div></section><form method="post" action="/consent"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="request_id" value="${escapeHtml(request.id)}"><div class="actions"><button name="decision" value="approve" type="submit">Approve</button><button class="secondary" name="decision" value="deny" type="submit">Deny</button></div></form>`,
  });
}

export function adminClientsPage(
  clients: readonly ClientView[],
  csrf: string,
  secret: string | null,
): string {
  const rows = clients
    .map((client) => {
      const status = client.disabledAt ? "disabled" : "active";
      return `<tr><td><code>${escapeHtml(client.id)}</code></td><td>${escapeHtml(client.name)}</td><td>${escapeHtml(client.type)}</td><td>${escapeHtml(status)}</td><td><code>${escapeHtml(client.scopes.join(" "))}</code></td><td class="table-actions">${adminAction(client.id, csrf, client.disabledAt ? "enable" : "disable", client.disabledAt ? "Enable" : "Disable")}${client.type === "confidential" ? adminAction(client.id, csrf, "rotate_secret", "Rotate secret") : ""}${adminAction(client.id, csrf, "revoke_grants", "Revoke grants")}</td></tr>`;
    })
    .join("");
  return pageDocument({
    title: "Client administration",
    eyebrow: "Administration",
    heading: "Client administration",
    summary:
      "Register OAuth clients and manage grants. New confidential client secrets are shown once.",
    visualEyebrow: "Client control",
    visualHeading: "Trust begins with narrow permissions.",
    visualSummary:
      "Redirects, scopes, origins, secrets, and active grants remain bounded per registered client.",
    tone: secret ? "warning" : "default",
    body: `${secret ? alertMessage(`New client secret, shown once: ${secret}`) : ""}<form method="post" action="/admin/clients" class="stacked-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label for="name">Client name</label><input id="name" name="name" required><label for="type">Client type</label><select id="type" name="type"><option value="public">public</option><option value="confidential">confidential</option></select><label for="redirect_uris">Redirect URIs, one per line</label><textarea id="redirect_uris" name="redirect_uris" required></textarea><label for="scopes">Allowed scopes</label><input id="scopes" name="scopes" value="openid email profile offline_access storage.read storage.write storage.delete"><label for="origins">Allowed browser origins, one per line</label><textarea id="origins" name="origins"></textarea><div class="actions"><button type="submit">Create client</button></div></form><section class="table-wrap" aria-label="Registered clients"><h2>Clients</h2><table><thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Status</th><th>Scopes</th><th>Actions</th></tr></thead><tbody>${rows || `<tr><td colspan="6">No clients registered yet.</td></tr>`}</tbody></table></section>`,
  });
}

export function deviceOutcomePage(status: "approved" | "denied"): string {
  const approved = status === "approved";
  return pageDocument({
    title: approved ? "Device approved" : "Device denied",
    eyebrow: "Device authorization",
    heading: approved ? "Device approved" : "Device denied",
    summary: approved
      ? "Return to the application that displayed this code. It can now complete the AittaDB token exchange."
      : "The application request was denied. No AittaDB credentials will be issued for this device code.",
    statusLabel: approved ? "Request approved" : "Request denied",
    tone: approved ? "success" : "warning",
    visualEyebrow: approved
      ? "Authorization complete"
      : "Authorization stopped",
    visualHeading: approved
      ? "Approved. The device can continue."
      : "Denied. No credentials cross this boundary.",
    visualSummary: approved
      ? "The application can finish its standards-based exchange without receiving any upstream ChatGPT credential."
      : "AittaDB records the denial so the polling application receives the standard access_denied response.",
    body: `<section class="info-grid" aria-label="Device outcome"><div><span>Status</span><strong>${status}</strong></div><div><span>Next step</span><strong>${approved ? "Return to the application" : "Close this page"}</strong></div></section>`,
    actions: [
      { href: "/", label: "Service" },
      { href: "/docs", label: "API docs", secondary: true },
    ],
  });
}

export function errorPage(
  title: string,
  message: string,
  options: {
    status?: number;
    error?: string;
    actions?: readonly PageAction[];
  } = {},
): string {
  const status = options.status ?? 400;
  return pageDocument({
    title,
    eyebrow: options.error ?? `HTTP ${status}`,
    heading: title,
    summary: message,
    status,
    tone: status === 403 ? "warning" : status >= 500 ? "danger" : "default",
    visualEyebrow: "Request boundary",
    visualHeading:
      status === 403
        ? "Access stops at the boundary."
        : status >= 500
          ? "AittaDB needs a moment."
          : "This request stopped here.",
    visualSummary:
      "AittaDB rejected this step without passing credentials or request secrets beyond its trust boundary.",
    body: `<section class="info-grid" aria-label="Error details"><div><span>Status</span><strong>${status}</strong></div>${options.error ? `<div><span>Error</span><code>${escapeHtml(options.error)}</code></div>` : ""}</section>`,
    actions: options.actions ?? [
      { href: "/", label: "Service" },
      { href: "/docs", label: "API docs", secondary: true },
    ],
  });
}

export function pageDocument(options: PageOptions): string {
  const tone = options.tone ?? "default";
  const toneLabel =
    options.statusLabel ??
    (tone === "success"
      ? "Service ready"
      : tone === "warning"
        ? "Attention required"
        : tone === "danger"
          ? "Service interruption"
          : "AittaDB service");
  const actions = options.actions?.length
    ? `<nav class="actions" aria-label="Available actions">${options.actions
        .map(
          (action) =>
            `<a class="button${action.secondary ? " secondary" : ""}" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`,
        )
        .join("")}</nav>`
    : "";
  const heading =
    options.heading === "AittaDB"
      ? `<h1 class="brand-heading" aria-label="AittaDB">${brandWordmark()}</h1>`
      : `<h1>${escapeHtml(options.heading)}</h1>`;
  const social = options.social
    ? `<meta name="description" content="${escapeHtml(options.social.description)}"><link rel="canonical" href="${escapeHtml(options.social.url)}"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(options.title)}"><meta property="og:description" content="${escapeHtml(options.social.description)}"><meta property="og:url" content="${escapeHtml(options.social.url)}"><meta property="og:image" content="${escapeHtml(options.social.imageUrl)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="AittaDB: ChatGPT sign-in, app-ready identity and data."><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(options.title)}"><meta name="twitter:description" content="${escapeHtml(options.social.description)}"><meta name="twitter:image" content="${escapeHtml(options.social.imageUrl)}">`
    : "";
  const layout = options.layout ?? "default";
  return `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0B234A"><title>${escapeHtml(options.title)}</title>${social}<link rel="icon" href="/aittadb-mark.svg"><link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/aittadb-boundary.jpg" as="image"><link rel="stylesheet" href="/auth-ui.css">${options.head ?? ""}</head><body class="aittadb-page"><main class="aittadb-shell tone-${tone} layout-${layout}"><aside class="visual-panel" aria-label="AittaDB sign-in and application-data boundary"><img class="visual-image" src="/aittadb-boundary.jpg" width="1254" height="1254" alt="" aria-hidden="true" fetchpriority="high" decoding="async"><div class="visual-inner"><a class="brand-lockup" href="/" aria-label="AittaDB service home"><img class="brand-mark" src="/aittadb-mark.svg" width="44" height="44" alt="">${brandWordmark()}</a><div class="visual-copy"><p class="visual-eyebrow">${escapeHtml(options.visualEyebrow ?? "Application backend")}</p><h2>${escapeHtml(options.visualHeading ?? "Hosted identity, data, and files for your app.")}</h2><p>${escapeHtml(options.visualSummary ?? "AittaDB creates a separate user, its own credentials, and isolated persistent storage without forwarding ChatGPT credentials.")}</p></div><div class="visual-legend" aria-label="ChatGPT sign-in to AittaDB application backend"><div><span>Upstream</span><strong>ChatGPT sign-in</strong></div><div><span>AittaDB</span><strong>Identity + sessions</strong></div><div><span>App data</span><strong>JSON + files</strong></div></div></div></aside><section class="content-panel"><header class="content-topline"><span class="authority-status"><span aria-hidden="true"></span>${toneLabel}</span><span class="protocol-label">Identity / Data / Files</span></header><div class="content-frame"><p class="eyebrow">${escapeHtml(options.eyebrow ?? "AittaDB")}</p>${heading}${options.summary ? `<p class="summary">${escapeHtml(options.summary)}</p>` : ""}${options.body}${actions}</div><footer class="page-footer"><div><a class="footer-brand" href="/" aria-label="AittaDB service home">${brandWordmark()}</a><span>Source-available under FSL-1.1-MIT</span></div><a class="repo-link" href="https://github.com/aittadb/aittadb" rel="noreferrer">View source on GitHub</a></footer></section></main>${options.scripts ?? ""}</body></html>`;
}

function brandWordmark(): string {
  return `<span class="brand-wordmark" aria-hidden="true"><span class="brand-aitta">Aitta</span><span class="brand-db">DB</span></span>`;
}

function adminAction(
  clientId: string,
  csrf: string,
  action: string,
  label: string,
): string {
  return `<form method="post" action="/admin/clients"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="client_id" value="${escapeHtml(clientId)}"><button class="secondary compact" name="action" value="${escapeHtml(action)}" type="submit">${escapeHtml(label)}</button></form>`;
}

function alertMessage(message: string): string {
  return `<p class="notice">${escapeHtml(message)}</p>`;
}

export function authUiCss(): string {
  return `@font-face{font-family:Inter;font-style:normal;font-display:swap;font-weight:100 900;src:url('/fonts/inter-latin-wght-normal.woff2') format('woff2-variations')}
  html{color-scheme:light}
  *{box-sizing:border-box}
  body.aittadb-page{--navy:#0b234a;--orange:#f04a32;--teal:#159ca6;--accent:#159ca6;--accent-strong:#0b6f77;--accent-soft:#e7f6f7;margin:0;min-height:100vh;padding:24px;background:#edf2f4;color:#15243d;font-family:Inter,system-ui,"Segoe UI",sans-serif;line-height:1.5;text-rendering:optimizeLegibility}
  .aittadb-page:before{content:"";position:fixed;inset:0;z-index:-1;background:repeating-linear-gradient(90deg,rgba(11,35,74,.035) 0 1px,transparent 1px 80px),#edf2f4}
  .aittadb-shell{width:min(100%,1240px);min-height:min(820px,calc(100vh - 48px));margin:0 auto;display:grid;grid-template-columns:minmax(390px,.92fr) minmax(0,1.08fr);background:#fff;border:1px solid #c9d4df;border-radius:8px;box-shadow:0 28px 72px rgba(11,35,74,.17);overflow:hidden}
  .tone-success{--accent:#159ca6;--accent-strong:#0b6f77;--accent-soft:#e7f6f7}.tone-warning{--accent:#d83e2a;--accent-strong:#a82c1d;--accent-soft:#fff0ed}.tone-danger{--accent:#c9342a;--accent-strong:#94231c;--accent-soft:#fdecea}
  .visual-panel{position:relative;min-height:720px;isolation:isolate;overflow:hidden;background:#0b234a;color:#fff}
  .visual-image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:56% center;z-index:-3}
  .visual-panel:before{content:"";position:absolute;inset:0;z-index:-2;background:linear-gradient(180deg,rgba(11,35,74,.48) 0%,rgba(11,35,74,.08) 38%,rgba(6,22,48,.94) 100%)}
  .visual-panel:after{content:"";position:absolute;inset:0;z-index:-1;box-shadow:inset 0 0 0 1px rgba(255,255,255,.09)}
  .visual-inner{height:100%;min-height:720px;padding:30px;display:grid;grid-template-rows:auto 1fr auto;gap:34px}
  .brand-lockup{width:max-content;max-width:100%;display:flex;align-items:center;gap:9px;padding:7px 13px 7px 8px;border:1px solid rgba(255,255,255,.72);border-radius:6px;background:rgba(255,255,255,.95);color:#0b234a;text-decoration:none;box-shadow:0 12px 30px rgba(4,18,42,.22);backdrop-filter:blur(14px)}
  .brand-mark{width:40px;height:40px;display:block;flex:none}
  .brand-wordmark{display:inline-flex;align-items:baseline;font-family:Inter,system-ui,"Segoe UI",sans-serif;font-size:1.16rem;font-weight:750;line-height:1;letter-spacing:0;white-space:nowrap}.brand-aitta{color:#0b234a}.brand-db{color:#f04a32}
  .visual-copy{align-self:end;max-width:490px;text-shadow:0 2px 24px rgba(0,0,0,.42)}
  .visual-eyebrow,.eyebrow{margin:0 0 11px;font-size:.76rem;font-weight:820;text-transform:uppercase;letter-spacing:0}
  .visual-eyebrow{color:#ff8a75}
  .visual-copy h2{max-width:12ch;margin:0;color:#fff;font-size:3.25rem;line-height:.98;font-weight:780;letter-spacing:0}
  .visual-copy>p:last-child{max-width:46ch;margin:18px 0 0;color:rgba(255,255,255,.82);font-size:1rem}
  .visual-legend{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;border-top:1px solid rgba(255,255,255,.3);padding-top:16px}
  .visual-legend div{min-width:0;padding:0 12px;border-left:1px solid rgba(255,255,255,.24)}
  .visual-legend div:first-child{padding-left:0;border-left:0}.visual-legend div:last-child{padding-right:0}
  .visual-legend span,.visual-legend strong{display:block;letter-spacing:0}
  .visual-legend span{margin-bottom:4px;color:rgba(255,255,255,.62);font-size:.7rem;text-transform:uppercase;font-weight:750}
  .visual-legend strong{color:#fff;font-size:.82rem;overflow-wrap:anywhere}
  .content-panel{min-width:0;display:grid;grid-template-rows:auto 1fr auto;padding:30px 42px 26px;background:#fff}
  .content-topline{display:flex;align-items:center;justify-content:space-between;gap:18px;padding-bottom:24px;border-bottom:1px solid #e2e7ed;color:#526278;font-size:.78rem;font-weight:720}
  .authority-status{display:inline-flex;align-items:center;gap:8px}.authority-status>span{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
  .protocol-label{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#65738a}
  .content-frame{width:min(100%,680px);align-self:center;justify-self:center;padding:44px 0}
  .layout-docs{width:min(100%,1560px);grid-template-columns:minmax(300px,.36fr) minmax(0,1.64fr)}
  .layout-docs .visual-copy h2{font-size:2.55rem}.layout-docs .visual-legend{grid-template-columns:1fr}.layout-docs .visual-legend div{padding:8px 0;border-left:0;border-top:1px solid rgba(255,255,255,.2)}.layout-docs .visual-legend div:first-child{border-top:0}
  .layout-docs .content-frame{width:100%;max-width:none;align-self:start;padding:36px 0}.layout-docs #swagger-ui{min-height:540px;margin-top:24px;border:1px solid #dbe3eb;border-radius:6px;overflow:hidden;background:#f7f9fb}.layout-docs #swagger-ui>p{padding:24px}
  .eyebrow{color:var(--accent)}
  .content-frame>h1{margin:0;color:#0b234a;font-size:3.35rem;line-height:1.01;font-weight:790;letter-spacing:0;text-wrap:balance}.brand-heading .brand-wordmark{font-size:inherit;font-weight:750}
  .content-frame>h2,.content-frame>section>h2,.table-wrap>h2{margin:32px 0 14px;color:#13284b;font-size:1.18rem;letter-spacing:0}
  .summary{max-width:60ch;margin:17px 0 28px;color:#53637a;font-size:1.08rem}
  .note,.notice{border:1px solid #bce1e4;border-left:4px solid var(--accent);background:var(--accent-soft);padding:14px 16px;border-radius:6px;color:#173d52}
  .tone-warning .notice,.tone-warning .note{border-color:#ead5ac;color:#5f451c}.tone-danger .notice,.tone-danger .note{border-color:#efc6bf;color:#702f26}.tone-success .notice,.tone-success .note{border-color:#bfdccb;color:#244c37}
  .info-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin:24px 0}
  .info-grid div{min-width:0;padding:15px;border:1px solid #dbe3eb;border-radius:6px;background:#fff;box-shadow:0 9px 22px rgba(11,35,74,.055)}
  .info-grid span{display:block;margin-bottom:6px;color:#68768a;font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:0}
  .operation-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:14px 0 24px}
  .operation-grid>a{min-width:0;display:grid;gap:6px;padding:15px;border:1px solid #dbe3eb;border-radius:6px;background:#fff;color:#0b234a;text-decoration:none;box-shadow:0 9px 22px rgba(11,35,74,.055);transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}
  .operation-grid>a:hover{border-color:#159ca6;box-shadow:0 13px 28px rgba(21,156,166,.14);transform:translateY(-1px)}
  .operation-grid strong{font-size:.94rem}.operation-grid span{color:#647287;font-size:.82rem;line-height:1.42}
  .content-frame>code,.content-frame>p code,.content-frame>section code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;overflow-wrap:anywhere}
  .content-frame>label,.content-frame>form label{display:block;margin:18px 0 7px;font-weight:760;color:#233752}
  .optional{color:#6c788a;font-size:.78rem;font-weight:560}
  .content-frame>form input,.content-frame>form textarea,.content-frame>form select,.content-frame>textarea{width:100%;border:1px solid #aab7c7;border-radius:6px;font:inherit;padding:12px 13px;background:#fff;color:#15243d;box-shadow:0 1px 0 rgba(255,255,255,.9) inset;transition:border-color .16s ease,box-shadow .16s ease}
  .content-frame>form input:hover,.content-frame>form textarea:hover,.content-frame>form select:hover,.content-frame>textarea:hover{border-color:#71839a}
  .content-frame>form input:focus,.content-frame>form textarea:focus,.content-frame>form select:focus,.content-frame>textarea:focus{border-color:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 16%,transparent)}
  .content-frame>form textarea,.content-frame>textarea{min-height:104px;resize:vertical}
  textarea.credential-input,textarea.credential-output{min-height:88px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.8rem;overflow-wrap:anywhere}.credential-output{background:#f4f7fa;color:#243954}
  .content-frame>p>a,.content-frame>section a,.content-frame>.actions>a,.page-footer a{color:var(--accent-strong)}
  .brand-lockup:focus-visible,.content-frame>p>a:focus-visible,.content-frame>section a:focus-visible,.content-frame>.actions>a:focus-visible,.page-footer a:focus-visible,.content-frame>form button:focus-visible,.content-frame>form input:focus-visible,.content-frame>form textarea:focus-visible,.content-frame>form select:focus-visible,.content-frame>textarea:focus-visible,.table-actions button:focus-visible{outline:3px solid #f04a32;outline-offset:3px}
  .content-frame>.actions,.content-frame>form .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:26px}
  .content-frame>form button,.content-frame>.actions>.button,.table-actions button{display:inline-flex;align-items:center;justify-content:center;min-height:46px;border:1px solid #0b234a;border-radius:6px;background:#0b234a;color:#fff;font:inherit;font-weight:780;padding:10px 17px;text-decoration:none;cursor:pointer;box-shadow:0 10px 24px rgba(11,35,74,.2);transition:transform .16s ease,box-shadow .16s ease,background-color .16s ease}
  .content-frame>form button:hover,.content-frame>.actions>.button:hover,.table-actions button:hover{transform:translateY(-1px);background:#159ca6;border-color:#0b6f77;box-shadow:0 14px 30px rgba(21,156,166,.24)}
  .content-frame>form button.secondary,.content-frame>.actions>.button.secondary,.table-actions button.secondary{background:#fff;color:var(--accent-strong);border-color:#b9c5bf;box-shadow:0 7px 18px rgba(25,46,40,.07)}
  .table-actions button.compact{min-height:34px;padding:5px 10px;font-size:.88rem;box-shadow:none}
  pre.json-output{white-space:pre-wrap;border:1px solid #183764;background:#0b234a;color:#edf7f8;border-radius:6px;padding:18px;overflow:auto;box-shadow:0 18px 38px rgba(11,35,74,.16)}
  .table-wrap{margin-top:30px;overflow-x:auto;border:1px solid #d9e1ea;border-radius:6px;background:#fff;box-shadow:0 14px 34px rgba(11,35,74,.07)}
  .table-wrap table{width:100%;border-collapse:collapse;font-size:.91rem}
  .table-wrap th,.table-wrap td{padding:12px;border-bottom:1px solid #e5e9e5;text-align:left;vertical-align:top}
  .table-wrap tbody tr:last-child td{border-bottom:0}
  .table-wrap th{color:#5e6c80;font-size:.72rem;text-transform:uppercase;letter-spacing:0;background:#f4f7fa}
  .table-actions{display:flex;flex-wrap:wrap;gap:8px}.table-actions form{margin:0}
  .page-footer{width:100%;display:flex;align-items:flex-end;justify-content:space-between;gap:22px;padding-top:20px;border-top:1px solid #e2e7ed;color:#667488;font-size:.82rem}
  .page-footer>div{display:grid;gap:5px}.page-footer>div>span{font-size:.75rem}.footer-brand{width:max-content;text-decoration:none}.footer-brand .brand-wordmark{font-size:.95rem}
  .repo-link{flex:none;font-weight:760;text-decoration-thickness:1px;text-underline-offset:3px}
  @media (max-width:860px){body.aittadb-page{padding:14px}.aittadb-shell{grid-template-columns:1fr;min-height:auto}.visual-panel,.visual-inner{min-height:360px}.visual-inner{padding:24px;gap:20px}.visual-image{object-position:center 55%}.visual-copy h2{max-width:16ch;font-size:2.55rem}.visual-copy>p:last-child{max-width:52ch;margin-top:12px}.visual-legend{display:none}.content-panel{padding:24px 28px}.content-frame{padding:38px 0}.content-frame>h1{font-size:2.75rem}}
  @media (max-width:540px){body.aittadb-page{padding:0}.aittadb-shell{border-width:0;border-radius:0;box-shadow:none}.visual-panel,.visual-inner{min-height:330px}.visual-inner{padding:20px}.brand-lockup{padding:6px 11px 6px 7px}.brand-mark{width:36px;height:36px}.visual-copy h2{font-size:2.15rem}.visual-copy>p:last-child{font-size:.92rem}.content-panel{padding:20px}.content-topline{align-items:flex-start;padding-bottom:18px}.protocol-label{display:none}.content-frame{padding:32px 0}.content-frame>h1{font-size:2.35rem}.info-grid,.operation-grid{grid-template-columns:1fr}.content-frame>.actions,.content-frame>form .actions{display:grid}.content-frame>.actions>.button,.content-frame>form button,.table-actions button{width:100%}.page-footer{align-items:flex-start;flex-direction:column}.repo-link{align-self:flex-start}}
  `;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
