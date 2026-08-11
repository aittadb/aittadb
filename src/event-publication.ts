import {
  APPLICATION_EVENT_MAX_DATA_BYTES,
  applicationEventExpiresAt,
  isValidApplicationEventType,
} from "./application-events";
import { issueBrowserSessionAccessToken } from "./browser-session";
import { nowSeconds, sha256, uuid } from "./crypto";
import {
  acceptsHtml,
  bearerToken,
  csrfTokenMatches,
  html,
  hypermediaError,
  hypermediaJson,
  isJsonMediaType,
  readBoundedRequestBody,
  readForm,
} from "./http";
import {
  HYPERMEDIA_MEDIA_TYPE,
  action,
  field,
  link,
  resourceDocument,
} from "./hypermedia";
import type { UpstreamIdentityProvider } from "./identity";
import { parseScopes, verifyAccessToken } from "./oauth";
import { errorPage, escapeHtml, pageDocument } from "./pages";
import type {
  AppConfig,
  ApplicationEvent,
  AuthStore,
  ClientView,
} from "./types";

export const APPLICATION_EVENT_JSON_MAX_BYTES =
  APPLICATION_EVENT_MAX_DATA_BYTES + 1024;
export const APPLICATION_EVENT_FORM_MAX_BYTES =
  APPLICATION_EVENT_MAX_DATA_BYTES * 3 + 4096;
export const APPLICATION_EVENT_IDEMPOTENCY_KEY_MAX_LENGTH = 200;

interface EventPrincipal {
  userId: string;
  client: ClientView;
}

interface PublicationInput {
  type: string;
  data: Record<string, unknown>;
  idempotencyKey: string | null;
}

interface EventData {
  id: string;
  type: string;
  data: Record<string, unknown>;
  created_at: number;
  expires_at: number;
}

export async function eventPublicationEndpoint(
  request: Request,
  store: AuthStore,
  config: AppConfig,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response> {
  if (request.method !== "POST") {
    return eventError(request, "invalid_request", "Method not allowed", 405);
  }

  if (isBrowserPublication(request)) {
    return browserPublication(request, store, config, identityProvider);
  }
  return publishCanonical(request, store, config);
}

async function browserPublication(
  request: Request,
  store: AuthStore,
  config: AppConfig,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response> {
  let form: URLSearchParams;
  try {
    form = await readForm(request, APPLICATION_EVENT_FORM_MAX_BYTES);
  } catch (error) {
    return error instanceof Error && error.message === "request_too_large"
      ? eventError(
          request,
          "invalid_request",
          "Event publication request is too large",
          413,
        )
      : eventError(
          request,
          "invalid_request",
          "URL-encoded browser form required",
          415,
        );
  }
  if (!csrfTokenMatches(request, form.get("csrf_token"))) {
    return eventError(
      request,
      "invalid_request",
      "CSRF validation failed",
      403,
    );
  }
  if (!hasExactBrowserPublicationFields(form)) {
    return eventError(
      request,
      "invalid_request",
      "Event form fields are invalid",
    );
  }

  const input = parsePublicationValues(
    request,
    form.get("type"),
    form.get("data"),
    form.get("idempotency_key"),
  );
  if (input instanceof Response) return input;

  const requestRateLimit = await enforceEventRequestRateLimit(
    request,
    store,
    config,
  );
  if (requestRateLimit) return requestRateLimit;

  const token = await issueBrowserSessionAccessToken(
    request,
    identityProvider,
    store,
    config,
    ["events.publish"],
  );
  if (token instanceof Response) return token;

  const headers = new Headers({
    accept: request.headers.get("accept") ?? "text/html",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });
  if (input.idempotencyKey) {
    headers.set("idempotency-key", input.idempotencyKey);
  }
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) headers.set("cf-connecting-ip", clientIp);
  return publishCanonical(
    new Request(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: input.type, data: input.data }),
    }),
    store,
    config,
    true,
  );
}

async function publishCanonical(
  request: Request,
  store: AuthStore,
  config: AppConfig,
  requestRateLimitChecked = false,
): Promise<Response> {
  const input = await parseCanonicalPublication(request);
  if (input instanceof Response) return input;

  if (!requestRateLimitChecked) {
    const requestRateLimit = await enforceEventRequestRateLimit(
      request,
      store,
      config,
    );
    if (requestRateLimit) return requestRateLimit;
  }

  const principal = await requireEventPublisher(request, store, config);
  if (principal instanceof Response) return principal;

  const now = nowSeconds();
  const rateKey = await sha256(
    `events:publish:${config.jwtPrivateJwk.d}:${principal.userId}:${principal.client.id}`,
  );
  if (
    !(await store.rateLimit(
      `events:publish:${rateKey}`,
      config.eventPublishRateLimit,
      60,
      now,
    ))
  ) {
    return eventRateLimitResponse(request);
  }

  const dataJson = JSON.stringify(input.data);
  const result = await store.appendApplicationEvent(
    {
      id: uuid(),
      userId: principal.userId,
      clientId: principal.client.id,
      type: input.type,
      dataJson,
      dataBytes: new TextEncoder().encode(dataJson).byteLength,
      idempotencyKeyHash: input.idempotencyKey
        ? await sha256(input.idempotencyKey)
        : null,
      requestHash: await sha256(JSON.stringify([input.type, input.data])),
      createdAt: now,
      expiresAt: applicationEventExpiresAt(now, config.eventRetentionSeconds),
    },
    config.eventLimits,
  );

  switch (result.status) {
    case "created":
    case "replayed":
      return eventResponse(request, result.event, config, result.status);
    case "conflict":
      return eventError(
        request,
        "idempotency_conflict",
        "The Idempotency-Key was already used for different event content",
        409,
      );
    case "quota_exceeded":
      return eventError(
        request,
        "event_limit_exceeded",
        "A configured AittaDB event limit has been reached",
        507,
      );
    case "unavailable":
      return eventError(request, "invalid_token", "Invalid token", 401);
  }
}

async function enforceEventRequestRateLimit(
  request: Request,
  store: AuthStore,
  config: AppConfig,
): Promise<Response | null> {
  const now = nowSeconds();
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const ipHash = await sha256(`rate-ip:${config.jwtPrivateJwk.d}:${ip}`);
  if (!(await store.rateLimit(`events-publish:ip:${ipHash}`, 120, 60, now))) {
    return eventRateLimitResponse(request);
  }
  if (!(await store.rateLimit("events-publish:global", 1200, 60, now))) {
    return eventRateLimitResponse(request);
  }
  return null;
}

function eventError(
  request: Request,
  error: string,
  description: string,
  status = 400,
): Response {
  if (acceptsHtml(request)) {
    const title =
      status === 401
        ? "Authentication required"
        : status === 403
          ? "Request forbidden"
          : status === 405
            ? "Method not allowed"
            : status === 409
              ? "Idempotency conflict"
              : status === 413
                ? "Request too large"
                : status === 415
                  ? "Unsupported request format"
                  : status === 429
                    ? "Too many requests"
                    : status >= 500
                      ? "Event unavailable"
                      : "Invalid event";
    return html(
      errorPage(title, description, {
        status,
        error,
        actions: [
          { href: "/events", label: "Event publication" },
          { href: "/session", label: "My signed-in session", secondary: true },
        ],
      }),
      { status },
    );
  }
  return hypermediaError(request, error, description, status, {
    links: [
      link("event-publication", "/events", { type: HYPERMEDIA_MEDIA_TYPE }),
      link("service", "/", { type: HYPERMEDIA_MEDIA_TYPE }),
      link("documentation", "/docs", { type: "text/html" }),
    ],
    actions: [
      action(
        "open-event-publication",
        "Open event publication",
        "GET",
        "/events",
        {
          fields: [],
        },
      ),
    ],
  });
}

function eventRateLimitResponse(request: Request): Response {
  const response = eventError(request, "slow_down", "Rate limit exceeded", 429);
  response.headers.set("retry-after", "60");
  return response;
}

async function parseCanonicalPublication(
  request: Request,
): Promise<PublicationInput | Response> {
  if (!isJsonMediaType(request.headers.get("content-type") ?? "")) {
    return eventError(
      request,
      "invalid_request",
      "JSON content type required",
      415,
    );
  }
  let text: string;
  try {
    text = new TextDecoder().decode(
      await readBoundedRequestBody(request, APPLICATION_EVENT_JSON_MAX_BYTES),
    );
  } catch (error) {
    return eventError(
      request,
      "invalid_request",
      error instanceof Error && error.message === "request_too_large"
        ? "Event publication request is too large"
        : "Malformed request body",
      error instanceof Error && error.message === "request_too_large"
        ? 413
        : 400,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return eventError(request, "invalid_request", "Malformed JSON body");
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).some((key) => !["type", "data"].includes(key))
  ) {
    return eventError(
      request,
      "invalid_request",
      "Event body must contain only type and data",
    );
  }
  return parsePublicationValues(
    request,
    parsed.type,
    parsed.data,
    request.headers.get("idempotency-key"),
  );
}

function parsePublicationValues(
  request: Request,
  type: unknown,
  data: unknown,
  idempotencyKey: unknown,
): PublicationInput | Response {
  if (typeof type !== "string" || !isValidApplicationEventType(type)) {
    return eventError(
      request,
      "invalid_request",
      "Event type must use 1-128 letters, digits, dots, colons, underscores, or hyphens",
    );
  }
  let parsedData = data;
  if (typeof parsedData === "string") {
    try {
      parsedData = JSON.parse(parsedData) as unknown;
    } catch {
      return eventError(
        request,
        "invalid_request",
        "Event data must be a JSON object",
      );
    }
  }
  if (!isRecord(parsedData)) {
    return eventError(
      request,
      "invalid_request",
      "Event data must be a JSON object",
    );
  }
  const dataBytes = new TextEncoder().encode(
    JSON.stringify(parsedData),
  ).byteLength;
  if (dataBytes > APPLICATION_EVENT_MAX_DATA_BYTES) {
    return eventError(
      request,
      "invalid_request",
      "Event data is too large",
      413,
    );
  }
  const key = typeof idempotencyKey === "string" ? idempotencyKey : null;
  if (key && !validIdempotencyKey(key)) {
    return eventError(
      request,
      "invalid_request",
      "Idempotency-Key must contain 1-200 visible ASCII characters",
    );
  }
  return { type, data: parsedData, idempotencyKey: key || null };
}

async function requireEventPublisher(
  request: Request,
  store: AuthStore,
  config: AppConfig,
): Promise<EventPrincipal | Response> {
  const token = bearerToken(request);
  if (!token)
    return eventError(request, "invalid_token", "Bearer token required", 401);
  const audience = parseJwtAudience(token);
  if (!audience)
    return eventError(request, "invalid_token", "Invalid token", 401);
  try {
    const verified = await verifyAccessToken(token, config, store, audience);
    const scopes = parseScopes(String(verified.claims.scope ?? ""));
    if (!scopes.includes("events.publish")) {
      return eventError(
        request,
        "insufficient_scope",
        "Required scope: events.publish",
        403,
      );
    }
    const client = await store.getClient(audience);
    if (!client || client.disabledAt) {
      return eventError(request, "invalid_token", "Invalid token", 401);
    }
    if (client.type === "service") {
      if (
        verified.claims.subject_type !== "service" ||
        verified.claims.sub !== client.id ||
        !(await store.hasServicePrincipal(client.id))
      ) {
        return eventError(request, "invalid_token", "Invalid token", 401);
      }
      return { userId: client.id, client };
    }
    if (verified.claims.subject_type !== undefined) {
      return eventError(request, "invalid_token", "Invalid token", 401);
    }
    const user = await store.getUser(verified.claims.sub);
    return user
      ? { userId: user.id, client }
      : eventError(request, "invalid_token", "Invalid token", 401);
  } catch {
    return eventError(request, "invalid_token", "Invalid token", 401);
  }
}

function eventResponse(
  request: Request,
  event: ApplicationEvent,
  config: AppConfig,
  status: "created" | "replayed",
): Response {
  const data = publicEventData(event);
  const location = `${config.issuerUrl}/events/${event.id}`;
  const headers = new Headers({ location });
  if (status === "replayed") headers.set("idempotency-replayed", "true");
  const responseStatus = status === "created" ? 201 : 200;
  return acceptsHtml(request)
    ? html(eventResultPage(data, status), { status: responseStatus, headers })
    : hypermediaJson(request, eventDocument(data, config), {
        status: responseStatus,
        headers,
      });
}

function eventDocument(data: EventData, config: AppConfig) {
  return resourceDocument({
    type: "application-event",
    id: data.id,
    data,
    links: [
      link("self", `${config.issuerUrl}/events/${data.id}`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      ...publicationLinks(config),
    ],
    actions: [],
  });
}

function publicationLinks(config: AppConfig) {
  return [
    link("collection", `${config.issuerUrl}/events`, {
      type: HYPERMEDIA_MEDIA_TYPE,
    }),
    link("service", config.issuerUrl, { type: HYPERMEDIA_MEDIA_TYPE }),
    link("documentation", `${config.issuerUrl}/docs`, { type: "text/html" }),
    link("describedby", `${config.issuerUrl}/openapi.json`, {
      type: "application/json",
    }),
  ];
}

export function eventPublicationAction(
  config: AppConfig,
  authorizationScheme: "bearer" | "sites-session",
  csrf?: string,
) {
  const session = authorizationScheme === "sites-session";
  return action(
    "publish-event",
    "Publish event",
    "POST",
    `${config.issuerUrl}/events`,
    {
      type: session ? "application/x-www-form-urlencoded" : "application/json",
      authorization: {
        scheme: authorizationScheme,
        scopes: ["events.publish"],
      },
      fields: [
        ...(session
          ? [
              field("csrf_token", "CSRF token", "string", "body", {
                required: true,
                secret: true,
                value: csrf ?? "",
              }),
            ]
          : []),
        field("type", "Event type", "string", "body", {
          required: true,
          min_length: 1,
          max_length: 128,
        }),
        field("data", "Event data", "object", "body", {
          required: true,
          max_bytes: APPLICATION_EVENT_MAX_DATA_BYTES,
          value: {},
        }),
        field(
          session ? "idempotency_key" : "Idempotency-Key",
          "Idempotency key",
          "string",
          session ? "body" : "header",
          { max_length: APPLICATION_EVENT_IDEMPOTENCY_KEY_MAX_LENGTH },
        ),
      ],
    },
  );
}

export function eventPublicationForm(csrf: string): string {
  return `<form method="post" action="/events" class="stacked-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label for="event_type">Event type</label><input id="event_type" name="type" maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}" autocomplete="off" required><label for="event_data">JSON object</label><textarea id="event_data" name="data" maxlength="65536" required>{}</textarea><label for="event_idempotency_key">Idempotency key <span class="note">(optional)</span></label><input id="event_idempotency_key" name="idempotency_key" maxlength="200" autocomplete="off"><div class="actions"><button type="submit">Publish event</button></div></form><p class="note">This form uses your current ChatGPT-backed AittaDB session. The resulting event belongs only to the reserved browser-client namespace; no ChatGPT credential or internal namespace identifier is stored in the event payload or returned.</p>`;
}

function eventResultPage(
  data: EventData,
  status: "created" | "replayed",
): string {
  return pageDocument({
    title: status === "created" ? "Event published" : "Event replayed",
    eyebrow: "Persistent application events",
    heading:
      status === "created" ? "Event published" : "Existing event returned",
    summary:
      status === "created"
        ? "AittaDB appended the immutable event to your current client namespace."
        : "The idempotency key matched an existing event, so AittaDB returned it without another write.",
    tone: "success",
    statusLabel: status === "created" ? "Created" : "Idempotent replay",
    visualEyebrow: "Event accepted",
    visualHeading:
      status === "created" ? "One durable append." : "One retry. No duplicate.",
    visualSummary:
      "Only the public event identifier, type, data, and server-derived lifecycle timestamps are shown.",
    body: `<section class="info-grid" aria-label="Event details"><div><span>Event ID</span><code>${escapeHtml(data.id)}</code></div><div><span>Type</span><code>${escapeHtml(data.type)}</code></div><div><span>Created</span><strong>${escapeHtml(new Date(data.created_at * 1000).toISOString())}</strong></div><div><span>Expires</span><strong>${escapeHtml(new Date(data.expires_at * 1000).toISOString())}</strong></div></section><section aria-labelledby="event-data-heading"><h2 id="event-data-heading">Event data</h2><pre><code>${escapeHtml(JSON.stringify(data.data, null, 2))}</code></pre></section>`,
    actions: [
      { href: "/events", label: "Publish another event" },
      { href: "/session", label: "My signed-in session", secondary: true },
    ],
  });
}

function publicEventData(event: ApplicationEvent): EventData {
  return {
    id: event.id,
    type: event.type,
    data: JSON.parse(event.dataJson) as Record<string, unknown>,
    created_at: event.createdAt,
    expires_at: event.expiresAt,
  };
}

function isBrowserPublication(request: Request): boolean {
  return (
    !bearerToken(request) &&
    (request.headers.get("content-type") ?? "")
      .toLowerCase()
      .includes("application/x-www-form-urlencoded")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactBrowserPublicationFields(form: URLSearchParams): boolean {
  const allowed = new Set(["csrf_token", "type", "data", "idempotency_key"]);
  for (const key of form.keys()) {
    if (!allowed.has(key) || form.getAll(key).length !== 1) return false;
  }
  return ["csrf_token", "type", "data"].every(
    (key) => form.getAll(key).length === 1,
  );
}

function validIdempotencyKey(value: string): boolean {
  if (
    value.length < 1 ||
    value.length > APPLICATION_EVENT_IDEMPOTENCY_KEY_MAX_LENGTH
  ) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function parseJwtAudience(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const padded = payload
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const claims = JSON.parse(atob(padded)) as { aud?: unknown };
    return typeof claims.aud === "string" ? claims.aud : null;
  } catch {
    return null;
  }
}
