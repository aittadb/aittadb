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
  return `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(options.title)}</title>${pageStyles()}</head><body class="sab-page"><main class="sab-shell tone-${tone}"><section class="brand-rail" aria-hidden="true"><div class="brand-card"><span class="brand-mark"><span></span></span><span>Sites Auth Broker</span></div><div class="signal-stack"><span></span><span></span><span></span></div></section><section class="content-panel"><p class="eyebrow">${escapeHtml(options.eyebrow ?? "Sites Auth Broker")}</p><h1>${escapeHtml(options.heading)}</h1>${options.summary ? `<p class="summary">${escapeHtml(options.summary)}</p>` : ""}${options.body}${actions}</section></main></body></html>`;
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

function pageStyles(): string {
  return `<style>
html{color-scheme:light}
body.sab-page{margin:0;min-height:100vh;background:#f6f8fb;color:#172033;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5}
.sab-page:before{content:"";position:fixed;inset:0;background:linear-gradient(135deg,#eef4fb 0%,#f8fafc 44%,#f7f2ea 100%);z-index:-2}
.sab-page:after{content:"";position:fixed;inset:0;background-image:linear-gradient(rgba(23,32,51,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(23,32,51,.055) 1px,transparent 1px);background-size:44px 44px;mask-image:linear-gradient(150deg,rgba(0,0,0,.65),transparent 70%);z-index:-1}
.sab-shell{box-sizing:border-box;width:min(100% - 28px,980px);margin:clamp(20px,5vw,56px) auto;display:grid;grid-template-columns:minmax(220px,300px) 1fr;min-height:560px;background:#fff;border:1px solid #d7dde8;border-radius:18px;box-shadow:0 24px 80px rgba(38,54,88,.14);overflow:hidden}
.brand-rail{position:relative;padding:28px;background:#152238;color:#f8fafc;display:flex;flex-direction:column;justify-content:space-between}
.brand-rail:before{content:"";position:absolute;inset:0;background:linear-gradient(155deg,rgba(62,178,168,.34),transparent 38%),linear-gradient(25deg,transparent 52%,rgba(245,168,92,.24));}
.brand-card,.signal-stack{position:relative}
.brand-card{display:flex;gap:12px;align-items:center;font-weight:750;letter-spacing:.02em}
.brand-mark{width:38px;height:38px;border-radius:10px;background:#f8fafc;display:grid;place-items:center;box-shadow:inset 0 0 0 1px rgba(255,255,255,.3)}
.brand-mark span{width:18px;height:18px;border:3px solid #1d6f8f;border-top-color:#f5a85c;border-radius:50%;display:block}
.signal-stack{display:grid;gap:14px;margin-top:42px}
.signal-stack span{height:10px;border-radius:999px;background:rgba(248,250,252,.28)}
.signal-stack span:nth-child(1){width:82%}.signal-stack span:nth-child(2){width:58%;background:rgba(62,178,168,.48)}.signal-stack span:nth-child(3){width:72%;background:rgba(245,168,92,.42)}
.content-panel{padding:clamp(24px,5vw,46px);align-self:center}
.eyebrow{margin:0 0 8px;color:#1d6f8f;font-size:.78rem;font-weight:800;text-transform:uppercase;letter-spacing:.12em}
h1{margin:0;color:#111827;font-size:clamp(2rem,4vw,3.35rem);line-height:1.02;letter-spacing:0}
h2{margin:30px 0 12px;font-size:1.1rem}
.summary{max-width:62ch;margin:16px 0 24px;color:#475569;font-size:1.08rem}
.note,.notice{border-left:4px solid #1d6f8f;background:#eef7f8;padding:12px 14px;border-radius:0 8px 8px 0;color:#274158}
.tone-warning .notice,.tone-warning .note{border-left-color:#b7791f;background:#fff7e8}.tone-danger .notice,.tone-danger .note{border-left-color:#b42318;background:#fff4f2}.tone-success .notice,.tone-success .note{border-left-color:#228b63;background:#edf9f3}
.info-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:22px 0}
.info-grid div{border:1px solid #dbe3ef;background:#f8fafc;border-radius:10px;padding:14px;min-width:0}
.info-grid span{display:block;color:#64748b;font-size:.82rem;font-weight:750;margin-bottom:4px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;overflow-wrap:anywhere}
label{display:block;margin:16px 0 6px;font-weight:750;color:#24324a}
input,textarea,select{box-sizing:border-box;width:100%;border:1px solid #9aa8bd;border-radius:8px;font:inherit;padding:11px 12px;background:#fff;color:#172033}
textarea{min-height:92px;resize:vertical}
a{color:#0f5fa8}
a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid #2f80ed;outline-offset:2px}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:22px}
button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:42px;border:1px solid #155e75;border-radius:8px;background:#155e75;color:#fff;font:inherit;font-weight:750;padding:9px 15px;text-decoration:none;cursor:pointer}
button.secondary,.button.secondary{background:#fff;color:#155e75}
button.compact{min-height:34px;padding:5px 10px;font-size:.9rem}
pre{white-space:pre-wrap;border:1px solid #dbe3ef;background:#111827;color:#eef7f8;border-radius:10px;padding:16px;overflow:auto}
.table-wrap{margin-top:28px;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.94rem}
th,td{padding:10px;border-bottom:1px solid #dbe3ef;text-align:left;vertical-align:top}
th{color:#475569;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
.table-actions{display:flex;flex-wrap:wrap;gap:8px}
.table-actions form{margin:0}
@media (max-width:760px){.sab-shell{grid-template-columns:1fr;min-height:auto}.brand-rail{min-height:150px}.content-panel{padding:24px}h1{font-size:2rem}}
</style>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
