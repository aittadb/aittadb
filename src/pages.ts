import type { AuthorizationRequest, ClientView, DeviceGrant } from "./types";

export function serviceHomePage(metadata: {
  service: string;
  issuer: string;
  docs: string;
  openapi: string;
  officialOpenAIProduct: boolean;
  _links?: Record<string, { href: string; type?: string }>;
  actions?: Record<string, unknown>;
}): string {
  return `<html lang="en"><head><title>${escapeHtml(metadata.service)}</title></head><body class="auth-page"><main class="auth-panel"><h1>${escapeHtml(metadata.service)}</h1><p>Independent OAuth 2.0, OpenID Connect, and JWT sessions from ChatGPT Sites identity.</p><p>This is not an official OpenAI product, and its tokens are issued only by Sites Auth Broker.</p><dl><dt>Issuer</dt><dd><code>${escapeHtml(metadata.issuer)}</code></dd><dt>Official OpenAI product</dt><dd>${metadata.officialOpenAIProduct ? "yes" : "no"}</dd></dl><div class="actions"><a class="button" href="/docs">API docs</a><a class="button secondary" href="/openapi.json">OpenAPI JSON</a><a class="button secondary" href="/health">Health</a></div></main></body></html>`;
}

export function healthPage(status: {
  ok: boolean;
  service: string;
  d1: boolean;
  _links?: Record<string, { href: string; type?: string }>;
}): string {
  return `<html lang="en"><head><title>Service health</title></head><body class="auth-page"><main class="auth-panel"><h1>Service health</h1><dl><dt>Status</dt><dd>${status.ok ? "ok" : "unavailable"}</dd><dt>Service</dt><dd><code>${escapeHtml(status.service)}</code></dd><dt>D1 binding</dt><dd>${status.d1 ? "available" : "unavailable"}</dd></dl><div class="actions"><a class="button" href="/">Service</a><a class="button secondary" href="/docs">API docs</a></div></main></body></html>`;
}

export function docsPage(): string {
  return `<html lang="en"><head><title>Sites Auth Broker API</title></head><body class="auth-page"><main class="auth-panel"><h1>Sites Auth Broker API</h1><p>This service issues its own OAuth 2.0, OpenID Connect, and JWT tokens from ChatGPT Sites server-side identity. It is not an official OpenAI project.</p><p><a href="/openapi.json">OpenAPI JSON</a></p><pre id="spec" aria-label="OpenAPI summary">GET /health
GET /.well-known/openid-configuration
GET /.well-known/jwks.json
GET /authorize
POST /oauth/device_authorization
POST /oauth/token
POST /oauth/revoke
POST /oauth/introspect
GET /userinfo</pre></main></body></html>`;
}

export function deviceEntryPage(
  userCode: string,
  csrf: string,
  error = "",
): string {
  return `<html lang="en"><head><title>Enter device code</title></head><body class="auth-page"><main class="auth-panel"><h1>Enter device code</h1>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<form method="post" action="/device"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label for="user_code">User code</label><input id="user_code" name="user_code" autocomplete="one-time-code" value="${escapeHtml(userCode)}" required><div class="actions"><button type="submit">Continue</button></div></form></main></body></html>`;
}

export function deviceConsentPage(
  grant: DeviceGrant,
  client: ClientView,
  csrf: string,
): string {
  return `<html lang="en"><head><title>Approve device</title></head><body class="auth-page"><main class="auth-panel"><h1>Approve device request</h1><p><strong>${escapeHtml(client.name)}</strong> is requesting local scopes:</p><p><code>${escapeHtml(grant.scope)}</code></p><p>User code: <strong>${escapeHtml(grant.userCodeDisplay)}</strong></p><form method="post" action="/device/decision"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="user_code" value="${escapeHtml(grant.userCodeDisplay)}"><div class="actions"><button name="decision" value="approve" type="submit">Approve</button><button class="secondary" name="decision" value="deny" type="submit">Deny</button></div></form></main></body></html>`;
}

export function consentPage(
  request: AuthorizationRequest,
  client: ClientView,
  csrf: string,
): string {
  return `<html lang="en"><head><title>Approve application</title></head><body class="auth-page"><main class="auth-panel"><h1>Approve application</h1><p><strong>${escapeHtml(client.name)}</strong> is requesting local scopes:</p><p><code>${escapeHtml(request.scope)}</code></p><form method="post" action="/consent"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="request_id" value="${escapeHtml(request.id)}"><div class="actions"><button name="decision" value="approve" type="submit">Approve</button><button class="secondary" name="decision" value="deny" type="submit">Deny</button></div></form></main></body></html>`;
}

export function adminClientsPage(
  clients: readonly ClientView[],
  csrf: string,
  secret: string | null,
): string {
  const rows = clients
    .map(
      (client) =>
        `<tr><td>${escapeHtml(client.id)}</td><td>${escapeHtml(client.name)}</td><td>${escapeHtml(client.type)}</td><td>${escapeHtml(client.scopes.join(" "))}</td></tr>`,
    )
    .join("");
  return `<html lang="en"><head><title>Client administration</title></head><body class="auth-page"><main class="auth-panel"><h1>Client administration</h1>${secret ? `<p class="error">New client secret, shown once: <code>${escapeHtml(secret)}</code></p>` : ""}<form method="post" action="/admin/clients"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label for="name">Client name</label><input id="name" name="name" required><label for="type">Client type</label><select id="type" name="type"><option value="public">public</option><option value="confidential">confidential</option></select><label for="redirect_uris">Redirect URIs, one per line</label><textarea id="redirect_uris" name="redirect_uris" required></textarea><label for="scopes">Allowed scopes</label><input id="scopes" name="scopes" value="openid email profile offline_access"><label for="origins">Allowed browser origins, one per line</label><textarea id="origins" name="origins"></textarea><div class="actions"><button type="submit">Create client</button></div></form><h2>Clients</h2><table><thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Scopes</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`;
}

export function errorPage(title: string, message: string): string {
  return `<html lang="en"><head><title>${escapeHtml(title)}</title></head><body class="auth-page"><main class="auth-panel"><h1>${escapeHtml(title)}</h1><p class="error">${escapeHtml(message)}</p></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
