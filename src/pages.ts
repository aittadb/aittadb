import type { AuthorizationRequest, ClientView, DeviceGrant } from "./types";

interface PageAction {
  href: string;
  label: string;
  secondary?: boolean;
}

interface PageOptions {
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
}

export function serviceHomePage(metadata: {
  service: string;
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
  tokenAuthority: string;
  _links?: Record<string, { href: string; type?: string }>;
  actions?: Record<string, unknown>;
}): string {
  return pageDocument({
    title: metadata.service,
    eyebrow: "Authentication broker",
    heading: metadata.service,
    summary:
      "Independent OAuth 2.0, OpenID Connect, and JWT sessions based on ChatGPT sign-in inside ChatGPT Sites.",
    visualEyebrow: "ChatGPT sign-in boundary",
    visualHeading: "ChatGPT sign-in. Your own local authority.",
    visualSummary:
      "ChatGPT signs the person into this Sites app. The broker maps that server-side signal to a separate local user and issues its own tokens.",
    body: `<section class="info-grid" aria-label="Service metadata"><div><span>Upstream sign-in</span><strong>${escapeHtml(metadata.upstreamSignIn.source)}</strong></div><div><span>Issuer</span><code>${escapeHtml(metadata.issuer)}</code></div><div><span>Official OpenAI product</span><strong>${metadata.officialOpenAIProduct ? "yes" : "no"}</strong></div><div><span>Token authority</span><strong>${escapeHtml(metadata.tokenAuthority)} only</strong></div></section><p class="note"><strong>ChatGPT supplies the browser sign-in inside ChatGPT Sites.</strong> Sites Auth Broker creates a separate local UUID and its own OAuth, OIDC, and JWT tokens. It never forwards ChatGPT credentials, and its tokens are not OpenAI or ChatGPT tokens.</p>`,
    actions: [
      { href: "/docs", label: "API docs" },
      { href: "/openapi.json", label: "OpenAPI JSON", secondary: true },
      { href: "/health", label: "Health", secondary: true },
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
      ? "The broker is reachable and ready to answer requests."
      : "The broker is reachable but one or more dependencies are unavailable.",
    tone: status.ok ? "success" : "danger",
    visualEyebrow: "Runtime map",
    visualHeading: status.ok
      ? "Every service, accounted for."
      : "One or more layers need attention.",
    visualSummary:
      "The broker reports its durable storage bindings without exposing operational secrets.",
    body: `<section class="info-grid" aria-label="Health checks"><div><span>Status</span><strong>${status.ok ? "ok" : "unavailable"}</strong></div><div><span>Service</span><code>${escapeHtml(status.service)}</code></div><div><span>D1 binding</span><strong>${status.d1 ? "available" : "unavailable"}</strong></div><div><span>R2 binding</span><strong>${status.r2 ? "available" : "unavailable"}</strong></div></section>`,
    actions: [
      { href: "/", label: "Service" },
      { href: "/docs", label: "API docs", secondary: true },
    ],
  });
}

export function docsPage(): string {
  return pageDocument({
    title: "Sites Auth Broker API",
    eyebrow: "API reference",
    heading: "Sites Auth Broker API",
    summary:
      "Minimal endpoint map for the OAuth 2.0, OpenID Connect, and administrative API surface.",
    visualEyebrow: "Protocol surface",
    visualHeading: "Familiar standards. One independent issuer.",
    visualSummary:
      "Discovery, authorization, tokens, identity, and storage remain explicit parts of the same local trust boundary.",
    body: `<p class="note">The canonical machine-readable OpenAPI 3.1 document is available as JSON. ChatGPT supplies the upstream sign-in inside ChatGPT Sites; downstream OAuth and OIDC tokens are issued only by Sites Auth Broker.</p><pre id="spec" aria-label="OpenAPI summary">GET /
GET /health
GET /.well-known/openid-configuration
GET /.well-known/jwks.json
GET /authorize
POST /oauth/device_authorization
POST /oauth/token
POST /oauth/revoke
POST /oauth/introspect
GET /userinfo
GET /storage/records
PUT /storage/records/{key}
GET /storage/records/{key}
DELETE /storage/records/{key}
GET /storage/files
PUT /storage/files/{key}
GET /storage/files/{key}
DELETE /storage/files/{key}
GET /openapi.json
GET /docs</pre>`,
    actions: [
      { href: "/openapi.json", label: "OpenAPI JSON" },
      { href: "/", label: "Service", secondary: true },
    ],
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
      "Approval creates broker-owned credentials for this client only. The upstream Sites credential never leaves the boundary.",
    body: `<section class="info-grid" aria-label="Device request"><div><span>Client</span><strong>${escapeHtml(client.name)}</strong></div><div><span>User code</span><strong>${escapeHtml(grant.userCodeDisplay)}</strong></div><div><span>Local scopes</span><code>${escapeHtml(grant.scope)}</code></div></section><form method="post" action="/device/decision"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="user_code" value="${escapeHtml(grant.userCodeDisplay)}"><div class="actions"><button name="decision" value="approve" type="submit">Approve</button><button class="secondary" name="decision" value="deny" type="submit">Deny</button></div></form>`,
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
      "This grants the client local Sites Auth Broker scopes. It does not grant access to ChatGPT or OpenAI data.",
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
          ? "The broker needs a moment."
          : "This request stopped here.",
    visualSummary:
      "The broker rejected this step without passing credentials or request secrets beyond its trust boundary.",
    body: `<section class="info-grid" aria-label="Error details"><div><span>Status</span><strong>${status}</strong></div>${options.error ? `<div><span>Error</span><code>${escapeHtml(options.error)}</code></div>` : ""}</section>`,
    actions: options.actions ?? [
      { href: "/", label: "Service" },
      { href: "/docs", label: "API docs", secondary: true },
    ],
  });
}

function pageDocument(options: PageOptions): string {
  const tone = options.tone ?? "default";
  const toneLabel =
    tone === "success"
      ? "Service ready"
      : tone === "warning"
        ? "Attention required"
        : tone === "danger"
          ? "Service interruption"
          : "Independent token issuer";
  const actions = options.actions?.length
    ? `<nav class="actions" aria-label="Available actions">${options.actions
        .map(
          (action) =>
            `<a class="button${action.secondary ? " secondary" : ""}" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`,
        )
        .join("")}</nav>`
    : "";
  return `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#15372f"><title>${escapeHtml(options.title)}</title><link rel="icon" href="/favicon.svg"><link rel="preload" href="/broker-aperture.jpg" as="image"><link rel="stylesheet" href="/auth-ui.css"></head><body class="sab-page"><main class="sab-shell tone-${tone}"><aside class="visual-panel" aria-label="Sites Auth Broker trust boundary"><img class="visual-image" src="/broker-aperture.jpg" width="1254" height="1254" alt="" aria-hidden="true" fetchpriority="high" decoding="async"><div class="visual-inner"><a class="brand-lockup" href="/" aria-label="Sites Auth Broker service home"><span class="brand-symbol" aria-hidden="true"><span></span></span><span>Sites Auth Broker</span></a><div class="visual-copy"><p class="visual-eyebrow">${escapeHtml(options.visualEyebrow ?? "Trust boundary")}</p><h2>${escapeHtml(options.visualHeading ?? "ChatGPT sign-in. Local authority out.")}</h2><p>${escapeHtml(options.visualSummary ?? "The broker creates a separate local user and standard credentials without forwarding upstream ChatGPT credentials.")}</p></div><div class="visual-legend" aria-label="ChatGPT sign-in to local token exchange"><div><span>Upstream</span><strong>ChatGPT sign-in</strong></div><div><span>Broker</span><strong>Local user UUID</strong></div><div><span>Downstream</span><strong>OAuth / OIDC</strong></div></div></div></aside><section class="content-panel"><header class="content-topline"><span class="authority-status"><span aria-hidden="true"></span>${toneLabel}</span><span class="protocol-label">OAuth 2.0 / OIDC</span></header><div class="content-frame"><p class="eyebrow">${escapeHtml(options.eyebrow ?? "Sites Auth Broker")}</p><h1>${escapeHtml(options.heading)}</h1>${options.summary ? `<p class="summary">${escapeHtml(options.summary)}</p>` : ""}${options.body}${actions}</div><footer class="page-footer"><div><strong>Sites Auth Broker</strong><span>Source-available under FSL-1.1-MIT</span></div><a class="repo-link" href="https://github.com/sendanor/sites-auth-broker" rel="noreferrer">View source on GitHub</a></footer></section></main></body></html>`;
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
  return `html{color-scheme:light}
  *{box-sizing:border-box}
  body.sab-page{--accent:#176c62;--accent-strong:#10534c;--accent-soft:#e8f3ef;margin:0;min-height:100vh;padding:24px;background:#e8ece8;color:#16201d;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5;text-rendering:optimizeLegibility}
  .sab-page:before{content:"";position:fixed;inset:0;z-index:-1;background:repeating-linear-gradient(90deg,rgba(27,60,51,.035) 0 1px,transparent 1px 80px),#e8ece8}
  .sab-shell{width:min(100%,1240px);min-height:min(820px,calc(100vh - 48px));margin:0 auto;display:grid;grid-template-columns:minmax(390px,.92fr) minmax(0,1.08fr);background:#fffdf9;border:1px solid #c4ccc6;border-radius:8px;box-shadow:0 28px 72px rgba(22,48,40,.17);overflow:hidden}
  .tone-success{--accent:#18714f;--accent-strong:#0d5439;--accent-soft:#e8f4ed}.tone-warning{--accent:#9a6517;--accent-strong:#71480e;--accent-soft:#fbf1df}.tone-danger{--accent:#b44b3d;--accent-strong:#873429;--accent-soft:#fbeae7}
  .visual-panel{position:relative;min-height:720px;isolation:isolate;overflow:hidden;background:#15372f;color:#fff}
  .visual-image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:56% center;z-index:-3}
  .visual-panel:before{content:"";position:absolute;inset:0;z-index:-2;background:linear-gradient(180deg,rgba(9,28,24,.38) 0%,rgba(9,28,24,.04) 42%,rgba(8,25,22,.9) 100%)}
  .visual-panel:after{content:"";position:absolute;inset:0;z-index:-1;box-shadow:inset 0 0 0 1px rgba(255,255,255,.09)}
  .visual-inner{height:100%;min-height:720px;padding:30px;display:grid;grid-template-rows:auto 1fr auto;gap:34px}
  .brand-lockup{width:max-content;max-width:100%;display:flex;align-items:center;gap:12px;color:#fff;text-decoration:none;font-weight:780;text-shadow:0 2px 16px rgba(0,0,0,.35)}
  .brand-symbol{width:38px;height:38px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.54);border-radius:8px;background:rgba(11,35,29,.34);backdrop-filter:blur(14px)}
  .brand-symbol span{position:relative;width:18px;height:18px;display:block;border:2px solid #f7f1e6;border-radius:50%}
  .brand-symbol span:after{content:"";position:absolute;width:6px;height:6px;right:-4px;bottom:-3px;border-radius:50%;background:#f29a73;border:2px solid #16372f}
  .visual-copy{align-self:end;max-width:490px;text-shadow:0 2px 24px rgba(0,0,0,.42)}
  .visual-eyebrow,.eyebrow{margin:0 0 11px;font-size:.76rem;font-weight:820;text-transform:uppercase;letter-spacing:0}
  .visual-eyebrow{color:#f4b28f}
  .visual-copy h2{max-width:12ch;margin:0;color:#fff;font-size:3.25rem;line-height:.98;font-weight:780;letter-spacing:0}
  .visual-copy>p:last-child{max-width:46ch;margin:18px 0 0;color:rgba(255,255,255,.82);font-size:1rem}
  .visual-legend{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;border-top:1px solid rgba(255,255,255,.3);padding-top:16px}
  .visual-legend div{min-width:0;padding:0 12px;border-left:1px solid rgba(255,255,255,.24)}
  .visual-legend div:first-child{padding-left:0;border-left:0}.visual-legend div:last-child{padding-right:0}
  .visual-legend span,.visual-legend strong{display:block;letter-spacing:0}
  .visual-legend span{margin-bottom:4px;color:rgba(255,255,255,.62);font-size:.7rem;text-transform:uppercase;font-weight:750}
  .visual-legend strong{color:#fff;font-size:.82rem;overflow-wrap:anywhere}
  .content-panel{min-width:0;display:grid;grid-template-rows:auto 1fr auto;padding:30px 42px 26px;background:#fffdf9}
  .content-topline{display:flex;align-items:center;justify-content:space-between;gap:18px;padding-bottom:24px;border-bottom:1px solid #e2e6e1;color:#53635e;font-size:.78rem;font-weight:720}
  .authority-status{display:inline-flex;align-items:center;gap:8px}.authority-status>span{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
  .protocol-label{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#6c7773}
  .content-frame{width:min(100%,680px);align-self:center;justify-self:center;padding:44px 0}
  .eyebrow{color:var(--accent)}
  h1{margin:0;color:#131a18;font-size:3.35rem;line-height:1.01;font-weight:790;letter-spacing:0;text-wrap:balance}
  h2{margin:32px 0 14px;color:#17211e;font-size:1.18rem;letter-spacing:0}
  .summary{max-width:60ch;margin:17px 0 28px;color:#596762;font-size:1.08rem}
  .note,.notice{border:1px solid #cbded7;border-left:4px solid var(--accent);background:var(--accent-soft);padding:14px 16px;border-radius:6px;color:#28433b}
  .tone-warning .notice,.tone-warning .note{border-color:#ead5ac;color:#5f451c}.tone-danger .notice,.tone-danger .note{border-color:#efc6bf;color:#702f26}.tone-success .notice,.tone-success .note{border-color:#bfdccb;color:#244c37}
  .info-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin:24px 0}
  .info-grid div{min-width:0;padding:15px;border:1px solid #dce1dc;border-radius:6px;background:#fff;box-shadow:0 9px 22px rgba(25,46,40,.055)}
  .info-grid span{display:block;margin-bottom:6px;color:#68756f;font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:0}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;overflow-wrap:anywhere}
  label{display:block;margin:18px 0 7px;font-weight:760;color:#26332f}
  input,textarea,select{width:100%;border:1px solid #aab6b0;border-radius:6px;font:inherit;padding:12px 13px;background:#fff;color:#17201e;box-shadow:0 1px 0 rgba(255,255,255,.9) inset;transition:border-color .16s ease,box-shadow .16s ease}
  input:hover,textarea:hover,select:hover{border-color:#74847d}
  input:focus,textarea:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 16%,transparent)}
  textarea{min-height:104px;resize:vertical}
  a{color:var(--accent-strong)}
  a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid #f29a73;outline-offset:3px}
  .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:26px}
  button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:46px;border:1px solid var(--accent-strong);border-radius:6px;background:var(--accent-strong);color:#fff;font:inherit;font-weight:780;padding:10px 17px;text-decoration:none;cursor:pointer;box-shadow:0 10px 24px color-mix(in srgb,var(--accent-strong) 20%,transparent);transition:transform .16s ease,box-shadow .16s ease,background-color .16s ease}
  button:hover,.button:hover{transform:translateY(-1px);background:var(--accent);box-shadow:0 14px 30px color-mix(in srgb,var(--accent-strong) 24%,transparent)}
  button.secondary,.button.secondary{background:#fff;color:var(--accent-strong);border-color:#b9c5bf;box-shadow:0 7px 18px rgba(25,46,40,.07)}
  button.compact{min-height:34px;padding:5px 10px;font-size:.88rem;box-shadow:none}
  pre{white-space:pre-wrap;border:1px solid #263a34;background:#14251f;color:#eaf4ef;border-radius:6px;padding:18px;overflow:auto;box-shadow:0 18px 38px rgba(17,35,29,.16)}
  .table-wrap{margin-top:30px;overflow-x:auto;border:1px solid #d9dfda;border-radius:6px;background:#fff;box-shadow:0 14px 34px rgba(25,46,40,.07)}
  table{width:100%;border-collapse:collapse;font-size:.91rem}
  th,td{padding:12px;border-bottom:1px solid #e5e9e5;text-align:left;vertical-align:top}
  tbody tr:last-child td{border-bottom:0}
  th{color:#5e6d67;font-size:.72rem;text-transform:uppercase;letter-spacing:0;background:#f4f6f3}
  .table-actions{display:flex;flex-wrap:wrap;gap:8px}.table-actions form{margin:0}
  .page-footer{width:100%;display:flex;align-items:flex-end;justify-content:space-between;gap:22px;padding-top:20px;border-top:1px solid #e2e6e1;color:#66736e;font-size:.82rem}
  .page-footer div{display:grid;gap:2px}.page-footer strong{color:#27332f}.page-footer span{font-size:.75rem}
  .repo-link{flex:none;font-weight:760;text-decoration-thickness:1px;text-underline-offset:3px}
  @media (max-width:860px){body.sab-page{padding:14px}.sab-shell{grid-template-columns:1fr;min-height:auto}.visual-panel,.visual-inner{min-height:360px}.visual-inner{padding:24px;gap:20px}.visual-image{object-position:center 55%}.visual-copy h2{max-width:16ch;font-size:2.55rem}.visual-copy>p:last-child{max-width:52ch;margin-top:12px}.visual-legend{display:none}.content-panel{padding:24px 28px}.content-frame{padding:38px 0}h1{font-size:2.75rem}}
  @media (max-width:540px){body.sab-page{padding:0}.sab-shell{border-width:0;border-radius:0;box-shadow:none}.visual-panel,.visual-inner{min-height:330px}.visual-inner{padding:20px}.visual-copy h2{font-size:2.15rem}.visual-copy>p:last-child{font-size:.92rem}.content-panel{padding:20px}.content-topline{align-items:flex-start;padding-bottom:18px}.protocol-label{display:none}.content-frame{padding:32px 0}h1{font-size:2.35rem}.info-grid{grid-template-columns:1fr}.actions{display:grid}.button,button{width:100%}.page-footer{align-items:flex-start;flex-direction:column}.repo-link{align-self:flex-start}}
  `;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
