import { escapeHtml, pageDocument, type PageAction } from "./pages";

export function structuredDataPage(options: {
  title: string;
  eyebrow: string;
  summary: string;
  payload: unknown;
  rawHref: string;
  visualHeading: string;
}): string {
  return pageDocument({
    title: options.title,
    eyebrow: options.eyebrow,
    heading: options.title,
    summary: options.summary,
    visualEyebrow: "Machine-readable contract",
    visualHeading: options.visualHeading,
    visualSummary:
      "The browser view and raw representation are generated from the same AittaDB service contract.",
    body: jsonBlock(options.payload, `${options.title} JSON`),
    actions: [
      { href: options.rawHref, label: "Raw JSON" },
      { href: "/docs", label: "API docs", secondary: true },
      { href: "/", label: "Service home", secondary: true },
    ],
  });
}

export function authorizationFormPage(): string {
  return pageDocument({
    title: "Authorization code",
    eyebrow: "OAuth 2.0 with PKCE",
    heading: "Authorization code",
    summary:
      "Start the production authorization endpoint for an exact registered redirect URI and an S256 PKCE challenge.",
    visualEyebrow: "Redirect-bound authorization",
    visualHeading: "A registered client. An exact return path.",
    visualSummary:
      "AittaDB validates the client, redirect URI, scopes, state, nonce, and PKCE challenge before consent.",
    body: `<form method="get" action="/authorize" class="stacked-form"><input type="hidden" name="response_type" value="code"><input type="hidden" name="code_challenge_method" value="S256"><label for="authorize_client_id">Client ID</label><input id="authorize_client_id" name="client_id" autocomplete="off" required><label for="authorize_redirect_uri">Exact redirect URI</label><input id="authorize_redirect_uri" name="redirect_uri" type="url" autocomplete="off" required><label for="authorize_scope">Local scopes</label><input id="authorize_scope" name="scope" value="openid email profile" autocomplete="off"><label for="authorize_state">State</label><input id="authorize_state" name="state" autocomplete="off"><label for="authorize_nonce">OIDC nonce</label><input id="authorize_nonce" name="nonce" autocomplete="off"><label for="authorize_code_challenge">S256 code challenge</label><textarea id="authorize_code_challenge" name="code_challenge" class="credential-input" autocomplete="off" spellcheck="false" required></textarea><div class="actions"><button type="submit">Continue to consent</button></div></form><p class="note">This form invokes <code>GET /authorize</code> directly. Consent and token exchange use the same production grant records as API clients.</p>`,
    actions: [
      { href: "/session", label: "My session", secondary: true },
      { href: "/docs", label: "API docs", secondary: true },
    ],
  });
}

export function deviceAuthorizationFormPage(csrf: string): string {
  return pageDocument({
    title: "Device authorization",
    eyebrow: "OAuth 2.0 device grant",
    heading: "Device authorization",
    summary:
      "Create a real device grant for a registered client, then approve its user code through ChatGPT sign-in.",
    visualEyebrow: "Device handoff",
    visualHeading: "Begin on one device. Approve in this browser.",
    visualSummary:
      "The production endpoint creates the same expiring, one-time grant used by CLI clients implementing RFC 8628.",
    body: `<form method="post" action="/oauth/device_authorization" class="stacked-form">${browserFields(csrf)}<label for="device_client_id">Client ID</label><input id="device_client_id" name="client_id" autocomplete="off" required><label for="device_client_secret">Client secret <span class="optional">confidential clients only</span></label><input id="device_client_secret" name="client_secret" type="password" autocomplete="new-password"><label for="device_scope">Local scopes</label><input id="device_scope" name="scope" value="openid email profile offline_access" autocomplete="off"><div class="actions"><button type="submit">Create device grant</button></div></form>`,
    actions: [
      { href: "/device", label: "Enter existing code", secondary: true },
      { href: "/docs", label: "API docs", secondary: true },
    ],
  });
}

export function deviceAuthorizationResultPage(
  payload: Record<string, unknown>,
): string {
  const verificationUri = stringValue(payload.verification_uri);
  const completeUri = stringValue(payload.verification_uri_complete);
  return pageDocument({
    title: "Device grant created",
    eyebrow: "OAuth 2.0 device grant",
    heading: "Device grant created",
    summary:
      "Approve the displayed user code in a signed-in browser while the client polls the token endpoint.",
    tone: "success",
    visualEyebrow: "Grant ready",
    visualHeading: "The user code is ready for approval.",
    visualSummary:
      "The device code stays with the requesting application. The short user code crosses into the browser confirmation step.",
    body: `<section class="info-grid" aria-label="Device authorization response"><div><span>User code</span><strong>${escapeHtml(stringValue(payload.user_code))}</strong></div><div><span>Expires in</span><strong>${escapeHtml(stringValue(payload.expires_in))} seconds</strong></div><div><span>Polling interval</span><strong>${escapeHtml(stringValue(payload.interval))} seconds</strong></div><div><span>Verification URI</span><code>${escapeHtml(verificationUri)}</code></div></section><label for="device_code_result">Device code</label><textarea id="device_code_result" class="credential-output" readonly spellcheck="false">${escapeHtml(stringValue(payload.device_code))}</textarea><p class="notice"><strong>Keep the device code private.</strong> It is a bearer-equivalent one-time credential returned by the production endpoint and is shown only in this response.</p>`,
    actions: [
      ...(completeUri
        ? [{ href: completeUri, label: "Approve user code" }]
        : []),
      { href: "/oauth/token", label: "Poll token endpoint", secondary: true },
      {
        href: "/oauth/device_authorization",
        label: "Create another grant",
        secondary: true,
      },
    ],
  });
}

export function tokenFormPage(csrf: string): string {
  return pageDocument({
    title: "Token exchange",
    eyebrow: "OAuth 2.0 token endpoint",
    heading: "Token exchange",
    summary:
      "Exchange a production device code, authorization code, or refresh token for AittaDB-issued credentials.",
    visualEyebrow: "Credential exchange",
    visualHeading: "One endpoint. Three standards-based grants.",
    visualSummary:
      "The token endpoint validates the selected grant, registered client, one-time state, and rotation rules before issuing credentials.",
    body: `<form method="post" action="/oauth/token" class="stacked-form">${browserFields(csrf)}<label for="token_grant_type">Grant type</label><select id="token_grant_type" name="grant_type" required><option value="urn:ietf:params:oauth:grant-type:device_code">Device code</option><option value="authorization_code">Authorization code</option><option value="refresh_token">Refresh token</option></select><label for="token_client_id">Client ID</label><input id="token_client_id" name="client_id" autocomplete="off" required><label for="token_client_secret">Client secret <span class="optional">confidential clients only</span></label><input id="token_client_secret" name="client_secret" type="password" autocomplete="new-password"><label for="token_device_code">Device code</label><textarea id="token_device_code" name="device_code" class="credential-input" autocomplete="off" spellcheck="false"></textarea><label for="token_code">Authorization code</label><textarea id="token_code" name="code" class="credential-input" autocomplete="off" spellcheck="false"></textarea><label for="token_redirect_uri">Redirect URI for authorization code</label><input id="token_redirect_uri" name="redirect_uri" type="url" autocomplete="off"><label for="token_code_verifier">PKCE code verifier</label><textarea id="token_code_verifier" name="code_verifier" class="credential-input" autocomplete="off" spellcheck="false"></textarea><label for="token_refresh_token">Refresh token</label><textarea id="token_refresh_token" name="refresh_token" class="credential-input" autocomplete="off" spellcheck="false"></textarea><div class="actions"><button type="submit">Exchange grant</button></div></form><p class="note">Only fields belonging to the selected grant are evaluated. Successful credentials are shown once in the next no-store response and are never placed in a URL.</p>`,
    actions: [
      {
        href: "/oauth/device_authorization",
        label: "Create device grant",
        secondary: true,
      },
      { href: "/authorize", label: "Start authorization", secondary: true },
    ],
  });
}

export function tokenResultPage(payload: Record<string, unknown>): string {
  const credentials = [
    ["access_token", "Access token"],
    ["id_token", "ID token"],
    ["refresh_token", "Refresh token"],
  ] as const;
  const outputs = credentials
    .filter(([key]) => typeof payload[key] === "string")
    .map(
      ([key, label]) =>
        `<label for="result_${key}">${label}</label><textarea id="result_${key}" class="credential-output" readonly spellcheck="false">${escapeHtml(stringValue(payload[key]))}</textarea>`,
    )
    .join("");
  return pageDocument({
    title: "Credentials issued",
    eyebrow: "OAuth 2.0 token response",
    heading: "Credentials issued",
    summary:
      "AittaDB issued credentials for the validated local user, client, and scope set.",
    tone: "success",
    visualEyebrow: "Exchange complete",
    visualHeading: "Independent AittaDB credentials are ready.",
    visualSummary:
      "These credentials belong only to this AittaDB issuer. They are not OpenAI or ChatGPT tokens.",
    body: `<section class="info-grid" aria-label="Token response metadata"><div><span>Token type</span><strong>${escapeHtml(stringValue(payload.token_type))}</strong></div><div><span>Expires in</span><strong>${escapeHtml(stringValue(payload.expires_in))} seconds</strong></div><div><span>Local scopes</span><code>${escapeHtml(stringValue(payload.scope))}</code></div></section>${outputs}<p class="notice"><strong>Store these credentials securely.</strong> This no-store page displays them only as the direct result of the production token exchange. AittaDB does not retain access or ID token plaintext.</p>`,
    actions: [
      { href: "/userinfo", label: "Open UserInfo" },
      { href: "/oauth/token", label: "New exchange", secondary: true },
      { href: "/oauth/revoke", label: "Revoke a token", secondary: true },
    ],
  });
}

export function revocationFormPage(csrf: string): string {
  return credentialOperationForm({
    title: "Token revocation",
    eyebrow: "OAuth 2.0 revocation",
    summary:
      "Submit a production refresh token for revocation. The endpoint intentionally returns success even when a token is already invalid.",
    action: "/oauth/revoke",
    csrf,
    fields: `<label for="revoke_token">Token</label><textarea id="revoke_token" name="token" class="credential-input" autocomplete="off" spellcheck="false" required></textarea><label for="revoke_hint">Token type hint</label><select id="revoke_hint" name="token_type_hint"><option value="refresh_token">refresh_token</option><option value="access_token">access_token</option></select><label for="revoke_client_id">Client ID <span class="optional">when required by client policy</span></label><input id="revoke_client_id" name="client_id" autocomplete="off"><label for="revoke_client_secret">Client secret</label><input id="revoke_client_secret" name="client_secret" type="password" autocomplete="new-password">`,
    submitLabel: "Revoke token",
    visualHeading: "End a credential without revealing its state.",
  });
}

export function introspectionFormPage(csrf: string): string {
  return credentialOperationForm({
    title: "Token introspection",
    eyebrow: "OAuth 2.0 introspection",
    summary:
      "An authorized confidential client can inspect whether an AittaDB access token is active for that client.",
    action: "/oauth/introspect",
    csrf,
    fields: `<label for="introspect_token">Access token</label><textarea id="introspect_token" name="token" class="credential-input" autocomplete="off" spellcheck="false" required></textarea><label for="introspect_hint">Token type hint</label><input id="introspect_hint" name="token_type_hint" value="access_token" autocomplete="off"><label for="introspect_client_id">Confidential client ID</label><input id="introspect_client_id" name="client_id" autocomplete="off" required><label for="introspect_client_secret">Client secret</label><input id="introspect_client_secret" name="client_secret" type="password" autocomplete="new-password" required>`,
    submitLabel: "Introspect token",
    visualHeading: "Inspect activity inside the client boundary.",
  });
}

export function userInfoFormPage(csrf: string): string {
  return credentialOperationForm({
    title: "UserInfo",
    eyebrow: "OpenID Connect claims",
    summary:
      "Submit an AittaDB bearer access token to the production UserInfo service without placing it in the URL.",
    action: "/userinfo",
    csrf,
    fields: `<label for="userinfo_token">Access token</label><textarea id="userinfo_token" name="access_token" class="credential-input" autocomplete="off" spellcheck="false" required></textarea>`,
    submitLabel: "Read UserInfo",
    visualHeading: "Claims follow the granted local scopes.",
  });
}

export function operationResultPage(options: {
  title: string;
  eyebrow: string;
  summary: string;
  payload: unknown;
  actions: readonly PageAction[];
  tone?: "default" | "success" | "warning" | "danger";
}): string {
  return pageDocument({
    title: options.title,
    eyebrow: options.eyebrow,
    heading: options.title,
    summary: options.summary,
    tone: options.tone,
    visualEyebrow: "Protocol result",
    visualHeading: "The production service answered this request.",
    visualSummary:
      "This readable representation contains the same result returned to a machine client, without changing the underlying operation.",
    body: jsonBlock(options.payload, `${options.title} result`),
    actions: options.actions,
  });
}

export function protocolErrorPage(
  payload: Record<string, unknown>,
  status: number,
  retryHref: string,
): string {
  const error = stringValue(payload.error) || "request_failed";
  const description =
    stringValue(payload.error_description) ||
    "The production endpoint rejected this request.";
  return pageDocument({
    title: "Request rejected",
    eyebrow: error,
    heading: "Request rejected",
    summary: description,
    status,
    tone: status === 403 ? "warning" : status >= 500 ? "danger" : "default",
    visualEyebrow: "Protocol boundary",
    visualHeading: "The request stopped before credentials crossed.",
    visualSummary:
      "AittaDB applied the same validation and error semantics used for non-browser clients.",
    body: `<section class="info-grid" aria-label="OAuth error"><div><span>Status</span><strong>${status}</strong></div><div><span>Error</span><code>${escapeHtml(error)}</code></div></section>`,
    actions: [
      { href: retryHref, label: "Review request" },
      { href: "/docs", label: "API docs", secondary: true },
    ],
  });
}

function credentialOperationForm(options: {
  title: string;
  eyebrow: string;
  summary: string;
  action: string;
  csrf: string;
  fields: string;
  submitLabel: string;
  visualHeading: string;
}): string {
  return pageDocument({
    title: options.title,
    eyebrow: options.eyebrow,
    heading: options.title,
    summary: options.summary,
    visualEyebrow: "Credential boundary",
    visualHeading: options.visualHeading,
    visualSummary:
      "Sensitive values travel in a same-origin request body, never in the browser URL or persistent client-side state.",
    body: `<form method="post" action="${escapeHtml(options.action)}" class="stacked-form">${browserFields(options.csrf)}${options.fields}<div class="actions"><button type="submit">${escapeHtml(options.submitLabel)}</button></div></form>`,
    actions: [
      { href: "/docs", label: "API docs", secondary: true },
      { href: "/session", label: "My session", secondary: true },
    ],
  });
}

function browserFields(csrf: string): string {
  return `<input type="hidden" name="ui" value="1"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">`;
}

function jsonBlock(payload: unknown, label: string): string {
  return `<pre class="json-output" aria-label="${escapeHtml(label)}">${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "";
}
