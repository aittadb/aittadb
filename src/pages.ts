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
  _links?: Record<string, { href: string; type?: string }>;
  actions?: Record<string, unknown>;
}): string {
  return pageDocument({
    title: metadata.service,
    eyebrow: "Authentication broker",
    heading: metadata.service,
    summary:
      "Independent OAuth 2.0, OpenID Connect, and JWT sessions from ChatGPT Sites identity.",
    body: `<section class="info-grid" aria-label="Service metadata"><div><span>Issuer</span><code>${escapeHtml(metadata.issuer)}</code></div><div><span>Official OpenAI product</span><strong>${metadata.officialOpenAIProduct ? "yes" : "no"}</strong></div><div><span>Token authority</span><strong>Sites Auth Broker only</strong></div></section><p class="note">This service does not issue OpenAI or ChatGPT tokens and does not expose ChatGPT credentials.</p>`,
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
    body: `<section class="info-grid" aria-label="Health checks"><div><span>Status</span><strong>${status.ok ? "ok" : "unavailable"}</strong></div><div><span>Service</span><code>${escapeHtml(status.service)}</code></div><div><span>D1 binding</span><strong>${status.d1 ? "available" : "unavailable"}</strong></div></section>`,
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
    body: `<p class="note">The canonical machine-readable OpenAPI 3.1 document is available as JSON. Browser sign-in is supplied by the Sites runtime; downstream OAuth and OIDC tokens are issued by this service.</p><pre id="spec" aria-label="OpenAPI summary">GET /
GET /health
GET /.well-known/openid-configuration
GET /.well-known/jwks.json
GET /authorize
POST /oauth/device_authorization
POST /oauth/token
POST /oauth/revoke
POST /oauth/introspect
GET /userinfo
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
    tone: secret ? "warning" : "default",
    body: `${secret ? alertMessage(`New client secret, shown once: ${secret}`) : ""}<form method="post" action="/admin/clients" class="stacked-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label for="name">Client name</label><input id="name" name="name" required><label for="type">Client type</label><select id="type" name="type"><option value="public">public</option><option value="confidential">confidential</option></select><label for="redirect_uris">Redirect URIs, one per line</label><textarea id="redirect_uris" name="redirect_uris" required></textarea><label for="scopes">Allowed scopes</label><input id="scopes" name="scopes" value="openid email profile offline_access"><label for="origins">Allowed browser origins, one per line</label><textarea id="origins" name="origins"></textarea><div class="actions"><button type="submit">Create client</button></div></form><section class="table-wrap" aria-label="Registered clients"><h2>Clients</h2><table><thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Status</th><th>Scopes</th><th>Actions</th></tr></thead><tbody>${rows || `<tr><td colspan="6">No clients registered yet.</td></tr>`}</tbody></table></section>`,
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
    body: `<section class="info-grid" aria-label="Error details"><div><span>Status</span><strong>${status}</strong></div>${options.error ? `<div><span>Error</span><code>${escapeHtml(options.error)}</code></div>` : ""}</section>`,
    actions: options.actions ?? [
      { href: "/", label: "Service" },
      { href: "/docs", label: "API docs", secondary: true },
    ],
  });
}

function pageDocument(options: PageOptions): string {
  const tone = options.tone ?? "default";
  const actions = options.actions?.length
    ? `<nav class="actions" aria-label="Available actions">${options.actions
        .map(
          (action) =>
            `<a class="button${action.secondary ? " secondary" : ""}" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`,
        )
        .join("")}</nav>`
    : "";
  return `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(options.title)}</title><link rel="stylesheet" href="/auth-ui.css"></head><body class="sab-page"><main class="sab-shell tone-${tone}"><section class="brand-rail"><div class="brand-card" aria-hidden="true"><span class="brand-mark"><span></span></span><span>Sites Auth Broker</span></div><div class="identity-graphic" aria-hidden="true"><div class="credential-card source-card"><span>Sites identity</span><strong>email signal</strong></div><div class="flow-line"><span></span><span></span><span></span></div><div class="credential-card broker-card"><span>Broker session</span><strong>OAuth / OIDC</strong></div><div class="token-stack"><span></span><span></span><span></span></div></div><div class="brand-footer"><p class="brand-note">Local tokens. Standard protocols. No ChatGPT credentials forwarded.</p><a class="repo-badge" href="https://github.com/sendanor/sites-auth-broker" rel="noreferrer"><span>GitHub</span><strong>sendanor/sites-auth-broker</strong><em>source-available</em></a></div></section><section class="content-panel"><div class="content-frame"><p class="eyebrow">${escapeHtml(options.eyebrow ?? "Sites Auth Broker")}</p><h1>${escapeHtml(options.heading)}</h1>${options.summary ? `<p class="summary">${escapeHtml(options.summary)}</p>` : ""}${options.body}${actions}</div><footer class="page-footer">Project source: <a href="https://github.com/sendanor/sites-auth-broker" rel="noreferrer">sendanor/sites-auth-broker on GitHub</a></footer></section></main></body></html>`;
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
body.sab-page{margin:0;min-height:100vh;background:#edf3f4;color:#172033;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5;text-rendering:optimizeLegibility}
.sab-page:before{content:"";position:fixed;inset:0;background:linear-gradient(126deg,#eff7f6 0%,#f7f9fc 40%,#fbf3e8 100%);z-index:-3}
.sab-page:after{content:"";position:fixed;inset:0;background:linear-gradient(120deg,rgba(18,48,65,.11) 1px,transparent 1px),linear-gradient(30deg,rgba(18,48,65,.07) 1px,transparent 1px);background-size:76px 76px,52px 52px;mask-image:linear-gradient(140deg,rgba(0,0,0,.72),transparent 76%);z-index:-2}
.sab-shell{box-sizing:border-box;width:min(100% - 28px,1120px);margin:clamp(18px,5vw,54px) auto;display:grid;grid-template-columns:minmax(310px,400px) minmax(0,1fr);min-height:clamp(610px,80vh,780px);background:rgba(255,255,255,.82);border:1px solid rgba(198,209,222,.82);border-radius:30px;box-shadow:0 34px 90px rgba(33,48,74,.18),0 2px 0 rgba(255,255,255,.78) inset;overflow:hidden;backdrop-filter:blur(22px)}
.brand-rail{position:relative;padding:34px;color:#f8fafc;display:flex;flex-direction:column;justify-content:space-between;background:linear-gradient(155deg,#102236 0%,#173d48 48%,#245f5f 100%);overflow:hidden}
.brand-rail:before{content:"";position:absolute;inset:0;background:linear-gradient(145deg,rgba(91,205,190,.28),transparent 42%),linear-gradient(25deg,transparent 48%,rgba(241,178,98,.24)),repeating-linear-gradient(135deg,rgba(255,255,255,.08) 0 1px,transparent 1px 18px)}
.brand-rail:after{content:"";position:absolute;left:34px;right:34px;bottom:116px;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.5),transparent)}
.brand-card,.identity-graphic,.brand-footer{position:relative}
.brand-card{display:flex;gap:13px;align-items:center;font-weight:800;letter-spacing:0}
.brand-mark{width:42px;height:42px;border-radius:14px;background:rgba(255,255,255,.96);display:grid;place-items:center;box-shadow:0 16px 34px rgba(0,0,0,.18)}
.brand-mark span{width:20px;height:20px;border:3px solid #236f80;border-top-color:#f1b262;border-radius:50%;display:block}
.identity-graphic{display:grid;gap:18px;margin:56px 0 34px}
.credential-card{border:1px solid rgba(255,255,255,.22);background:linear-gradient(145deg,rgba(255,255,255,.18),rgba(255,255,255,.08));border-radius:20px;padding:18px 18px 20px;box-shadow:0 22px 50px rgba(0,0,0,.18);backdrop-filter:blur(18px)}
.credential-card span{display:block;color:rgba(248,250,252,.7);font-size:.78rem;font-weight:800;text-transform:uppercase;letter-spacing:.12em}
.credential-card strong{display:block;margin-top:8px;font-size:1.2rem;letter-spacing:0}
.broker-card{margin-left:42px}
.flow-line{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;width:72%;margin-left:28px}
.flow-line:before,.flow-line:after{content:"";height:1px;background:rgba(255,255,255,.35)}
.flow-line span{width:8px;height:8px;border-radius:50%;background:#f1b262;box-shadow:0 0 0 6px rgba(241,178,98,.16)}
.flow-line span:nth-child(2){background:#71d2c3}.flow-line span:nth-child(3){background:#f8fafc}
.token-stack{display:grid;gap:10px;margin:10px 34px 0 68px}
.token-stack span{height:9px;border-radius:999px;background:rgba(248,250,252,.22)}
.token-stack span:nth-child(1){width:82%}.token-stack span:nth-child(2){width:58%;background:rgba(113,210,195,.4)}.token-stack span:nth-child(3){width:72%;background:rgba(241,178,98,.38)}
.brand-footer{display:grid;gap:16px}
.brand-note{margin:0;color:rgba(248,250,252,.78);font-size:.95rem}
.repo-badge{display:grid;grid-template-columns:1fr;gap:2px;width:min(100%,270px);box-sizing:border-box;border:1px solid rgba(255,255,255,.22);border-radius:16px;padding:13px 14px;background:rgba(255,255,255,.1);color:#f8fafc;text-decoration:none;box-shadow:0 16px 38px rgba(0,0,0,.16);backdrop-filter:blur(16px)}
.repo-badge:hover{background:rgba(255,255,255,.15)}
.repo-badge span{font-size:.72rem;font-weight:850;text-transform:uppercase;letter-spacing:.13em;color:rgba(248,250,252,.68)}
.repo-badge strong{font-size:.96rem;letter-spacing:0;overflow-wrap:anywhere}
.repo-badge em{font-style:normal;font-size:.82rem;color:rgba(248,250,252,.72)}
.content-panel{display:grid;grid-template-rows:1fr auto;align-items:center;padding:clamp(28px,5vw,58px);background:linear-gradient(180deg,rgba(255,255,255,.72),rgba(248,250,252,.92))}
.content-frame{width:min(100%,660px);justify-self:center}
.page-footer{align-self:end;justify-self:center;width:min(100%,660px);margin-top:32px;padding-top:18px;border-top:1px solid #dbe4ef;color:#657488;font-size:.92rem}
.page-footer a{font-weight:800}
.eyebrow{margin:0 0 10px;color:#1b7283;font-size:.76rem;font-weight:850;text-transform:uppercase;letter-spacing:.14em}
h1{margin:0;color:#101828;font-size:clamp(2.45rem,4.6vw,4.45rem);line-height:.96;letter-spacing:0}
h2{margin:34px 0 14px;font-size:1.18rem;color:#142033}
.summary{max-width:60ch;margin:18px 0 28px;color:#506071;font-size:1.11rem}
.note,.notice{border:1px solid rgba(76,144,154,.18);border-left:5px solid #247489;background:linear-gradient(135deg,#eefafa,#f8fbfd);padding:14px 16px;border-radius:14px;color:#284455;box-shadow:0 10px 26px rgba(37,88,101,.08)}
.tone-warning .notice,.tone-warning .note{border-left-color:#b7791f;background:linear-gradient(135deg,#fff8eb,#fffdf8)}.tone-danger .notice,.tone-danger .note{border-left-color:#b42318;background:linear-gradient(135deg,#fff3f1,#fffafa)}.tone-success .notice,.tone-success .note{border-left-color:#228b63;background:linear-gradient(135deg,#eefaf4,#fbfefd)}
.info-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:13px;margin:24px 0}
.info-grid div{border:1px solid rgba(204,214,226,.9);background:linear-gradient(180deg,#fff,#f8fbfc);border-radius:16px;padding:16px;min-width:0;box-shadow:0 12px 28px rgba(39,55,83,.06)}
.info-grid span{display:block;color:#667789;font-size:.78rem;font-weight:850;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;overflow-wrap:anywhere}
label{display:block;margin:18px 0 7px;font-weight:800;color:#24324a}
input,textarea,select{box-sizing:border-box;width:100%;border:1px solid #aeb9c8;border-radius:13px;font:inherit;padding:12px 14px;background:#fff;color:#172033;box-shadow:0 1px 0 rgba(255,255,255,.9) inset,0 10px 24px rgba(31,45,68,.05);transition:border-color .16s ease,box-shadow .16s ease}
input:hover,textarea:hover,select:hover{border-color:#7f91a7}
input:focus,textarea:focus,select:focus{border-color:#247489;box-shadow:0 0 0 4px rgba(36,116,137,.14)}
textarea{min-height:104px;resize:vertical}
a{color:#0e6176}
a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid #2f80ed;outline-offset:3px}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:26px}
button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:46px;border:1px solid #145f70;border-radius:13px;background:linear-gradient(180deg,#19788b,#145f70);color:#fff;font:inherit;font-weight:800;padding:10px 17px;text-decoration:none;cursor:pointer;box-shadow:0 16px 34px rgba(20,95,112,.2);transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease}
button:hover,.button:hover{transform:translateY(-1px);box-shadow:0 20px 40px rgba(20,95,112,.24)}
button.secondary,.button.secondary{background:rgba(255,255,255,.88);color:#145f70;border-color:#b7c7d3;box-shadow:0 10px 24px rgba(39,55,83,.08)}
button.compact{min-height:34px;padding:5px 10px;font-size:.88rem;border-radius:10px;box-shadow:none}
pre{white-space:pre-wrap;border:1px solid #26364c;background:linear-gradient(180deg,#101827,#172338);color:#e7f7f6;border-radius:16px;padding:18px;overflow:auto;box-shadow:0 22px 46px rgba(16,24,39,.18)}
.table-wrap{margin-top:30px;overflow-x:auto;border:1px solid #d9e1ec;border-radius:18px;background:#fff;box-shadow:0 18px 44px rgba(39,55,83,.07)}
table{width:100%;border-collapse:collapse;font-size:.94rem}
th,td{padding:12px;border-bottom:1px solid #e4ebf3;text-align:left;vertical-align:top}
tbody tr:last-child td{border-bottom:0}
th{color:#5f7083;font-size:.76rem;text-transform:uppercase;letter-spacing:.08em;background:#f7fafc}
.table-actions{display:flex;flex-wrap:wrap;gap:8px}
.table-actions form{margin:0}
@media (max-width:820px){.sab-shell{grid-template-columns:1fr;min-height:auto;border-radius:24px}.brand-rail{min-height:260px}.identity-graphic{margin:34px 0 18px}.broker-card{margin-left:28px}.content-panel{padding:26px}h1{font-size:2.35rem}}
@media (max-width:520px){.sab-shell{width:min(100% - 18px,1120px);margin:9px auto;border-radius:20px}.brand-rail{padding:24px}.content-panel{padding:22px}.info-grid{grid-template-columns:1fr}.actions{display:grid}.button,button{width:100%}.broker-card{margin-left:12px}.token-stack{margin-left:24px}}
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
