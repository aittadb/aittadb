import {
  decodeApplicationEventCursor,
  encodeApplicationEventCursor,
} from "./application-event-cursor";
import { assertApplicationEventType } from "./application-events";
import {
  hasBrowserSession,
  issueBrowserSessionAccessToken,
} from "./browser-session";
import { nowSeconds, sha256 } from "./crypto";
import {
  applicationEventCollectionPage,
  type ApplicationEventPageItem,
} from "./event-pages";
import {
  acceptsHtml,
  bearerToken,
  html,
  hypermediaError,
  hypermediaJson,
  oauthError,
} from "./http";
import {
  HYPERMEDIA_MEDIA_TYPE,
  action,
  field,
  link,
  resourceDocument,
  type HypermediaDocument,
} from "./hypermedia";
import {
  requireSitesIdentity,
  type UpstreamIdentityProvider,
} from "./identity";
import { parseScopes, verifyAccessToken } from "./oauth";
import type {
  AppConfig,
  ApplicationEvent,
  AuthStore,
  ClientView,
} from "./types";

type EventReadAuthorization = "bearer" | "sites-session";

interface EventPrincipal {
  principalId: string;
  client: ClientView;
}

interface EventPageRequest {
  cursor: string | null;
  afterSequence: number;
  pageSize: number;
  typeFilter: string | null;
}

interface EventItemData {
  id: string;
  type: string;
  data: Record<string, unknown>;
  created_at: number;
  expires_at: number;
}

const ALLOWED_EVENT_QUERY_PARAMETERS = new Set(["cursor", "page_size", "type"]);

export async function eventCollectionBrowserEndpoint(
  request: Request,
  url: URL,
  store: AuthStore,
  config: AppConfig,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response | null> {
  if (
    url.pathname !== "/events" ||
    request.method !== "GET" ||
    bearerToken(request)
  ) {
    return null;
  }
  if (!hasBrowserSession(request, identityProvider)) {
    if (acceptsHtml(request)) {
      return requireSitesIdentity(request, identityProvider) as Response;
    }
    return hypermediaError(
      request,
      "login_required",
      "ChatGPT sign-in inside ChatGPT Sites or an AittaDB bearer token is required",
      401,
      {
        links: [
          link("service", config.issuerUrl, {
            type: HYPERMEDIA_MEDIA_TYPE,
          }),
          link("session", `${config.issuerUrl}/session`, {
            type: HYPERMEDIA_MEDIA_TYPE,
          }),
        ],
        actions: [
          action(
            "begin-session",
            "Sign in to AittaDB",
            "GET",
            `${config.issuerUrl}/session`,
            { authorization: { scheme: "sites-session" }, fields: [] },
          ),
        ],
      },
    );
  }
  const token = await issueBrowserSessionAccessToken(
    request,
    identityProvider,
    store,
    config,
    ["events.read"],
  );
  if (token instanceof Response) return token;
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  return eventCollectionEndpoint(
    new Request(url, { method: "GET", headers }),
    url,
    store,
    config,
    "sites-session",
  );
}

export async function eventCollectionEndpoint(
  request: Request,
  url: URL,
  store: AuthStore,
  config: AppConfig,
  authorization: EventReadAuthorization = "bearer",
): Promise<Response> {
  const principal = await requireEventReadScope(request, store, config);
  if (principal instanceof Response) return noStore(principal);
  const page = await parseEventPage(url, principal, config);
  if (page instanceof Response) return noStore(page);
  const events = await store.listApplicationEvents(
    principal.principalId,
    principal.client.id,
    page.afterSequence,
    page.pageSize,
    page.typeFilter,
  );
  const checkpoint = events.items.at(-1)?.sequence ?? page.afterSequence;
  const resumeCursor = await encodeApplicationEventCursor(
    principal.principalId,
    principal.client.id,
    checkpoint,
    nowSeconds(),
    config,
    page.typeFilter,
  );
  const selfHref = eventPageHref(config, page, page.cursor);
  const resumeHref = eventPageHref(config, page, resumeCursor);
  const nextHref = events.hasMore ? resumeHref : null;
  const items = events.items.map((event) => eventItem(event, config));
  const document = resourceDocument({
    type: "application-event-collection",
    id: selfHref,
    data: {
      count: items.length,
      page_size: page.pageSize,
      has_more: events.hasMore,
      type_filter: page.typeFilter,
      resume_cursor: resumeCursor,
      items,
    },
    links: [
      link("self", selfHref, { type: HYPERMEDIA_MEDIA_TYPE }),
      ...(nextHref
        ? [link("next", nextHref, { type: HYPERMEDIA_MEDIA_TYPE })]
        : []),
      link("resume", resumeHref, { type: HYPERMEDIA_MEDIA_TYPE }),
      link("service", config.issuerUrl, { type: HYPERMEDIA_MEDIA_TYPE }),
      link("documentation", `${config.issuerUrl}/docs`, {
        type: "text/html",
      }),
      link("describedby", `${config.issuerUrl}/openapi.json`, {
        type: "application/json",
      }),
    ],
    actions: [
      action(
        "list-events",
        "List application events",
        "GET",
        `${config.issuerUrl}/events`,
        {
          accept: HYPERMEDIA_MEDIA_TYPE,
          authorization: { scheme: authorization, scopes: ["events.read"] },
          fields: [
            field("page_size", "Page size", "integer", "query", {
              required: false,
              min: 1,
              max: config.eventMaxPageSize,
              value: page.pageSize,
            }),
            field("type", "Exact event type", "string", "query", {
              required: false,
              max_length: 128,
              ...(page.typeFilter ? { value: page.typeFilter } : {}),
            }),
            field("cursor", "Opaque resume cursor", "string", "query", {
              required: false,
              max_length: 342,
            }),
          ],
        },
      ),
    ],
  });
  const response = acceptsHtml(request)
    ? html(
        applicationEventCollectionPage({
          items: events.items.map((event) => eventPageItem(event, config)),
          pageSize: page.pageSize,
          maxPageSize: config.eventMaxPageSize,
          typeFilter: page.typeFilter,
          nextHref,
          signedIn: authorization === "sites-session",
        }),
      )
    : hypermediaJson(request, document);
  return noStore(response);
}

async function requireEventReadScope(
  request: Request,
  store: AuthStore,
  config: AppConfig,
): Promise<EventPrincipal | Response> {
  const token = bearerToken(request);
  if (!token) return oauthError("invalid_token", "Bearer token required", 401);
  const audience = parseJwtAudience(token);
  if (!audience) return oauthError("invalid_token", "Invalid token", 401);
  try {
    const verified = await verifyAccessToken(token, config, store, audience);
    const scopes = parseScopes(String(verified.claims.scope || ""));
    if (!scopes.includes("events.read")) {
      return oauthError(
        "insufficient_scope",
        "Required scope: events.read",
        403,
      );
    }
    const client = await store.getClient(audience);
    if (!client || client.disabledAt) {
      return oauthError("invalid_token", "Invalid token", 401);
    }
    let principalId: string;
    if (client.type === "service") {
      if (
        verified.claims.subject_type !== "service" ||
        verified.claims.sub !== client.id ||
        !(await store.hasServicePrincipal(client.id))
      ) {
        return oauthError("invalid_token", "Invalid token", 401);
      }
      principalId = client.id;
    } else {
      if (verified.claims.subject_type !== undefined) {
        return oauthError("invalid_token", "Invalid token", 401);
      }
      const user = await store.getUser(verified.claims.sub);
      if (!user) return oauthError("invalid_token", "Invalid token", 401);
      principalId = user.id;
    }
    const ownerHash = await sha256(`${principalId}:${client.id}`);
    if (
      !(await store.rateLimit(
        `events:read:${ownerHash}`,
        config.eventReadRateLimit,
        60,
        nowSeconds(),
      ))
    ) {
      const response = oauthError("slow_down", "Rate limit exceeded", 429);
      response.headers.set("retry-after", "60");
      return response;
    }
    return { principalId, client };
  } catch {
    return oauthError("invalid_token", "Invalid token", 401);
  }
}

async function parseEventPage(
  url: URL,
  principal: EventPrincipal,
  config: AppConfig,
): Promise<EventPageRequest | Response> {
  for (const key of url.searchParams.keys()) {
    if (
      !ALLOWED_EVENT_QUERY_PARAMETERS.has(key) ||
      url.searchParams.getAll(key).length !== 1
    ) {
      return oauthError("invalid_request", "Invalid Events query");
    }
  }
  const rawPageSize = url.searchParams.get("page_size");
  const pageSize = rawPageSize
    ? Number.parseInt(rawPageSize, 10)
    : config.eventDefaultPageSize;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > config.eventMaxPageSize ||
    (rawPageSize !== null && String(pageSize) !== rawPageSize)
  ) {
    return oauthError(
      "invalid_request",
      `page_size must be an integer from 1 to ${config.eventMaxPageSize}`,
    );
  }
  const typeFilter = url.searchParams.get("type");
  if (typeFilter !== null) {
    try {
      assertApplicationEventType(typeFilter);
    } catch {
      return oauthError("invalid_request", "Invalid event type filter");
    }
  }
  const cursor = url.searchParams.get("cursor");
  const checkpoint = cursor
    ? await decodeApplicationEventCursor(
        cursor,
        principal.principalId,
        principal.client.id,
        nowSeconds(),
        config,
        typeFilter,
      )
    : { afterSequence: 0 };
  if (!checkpoint) {
    return oauthError("invalid_request", "Invalid event cursor");
  }
  return {
    cursor,
    afterSequence: checkpoint.afterSequence,
    pageSize,
    typeFilter,
  };
}

function eventItem(
  event: ApplicationEvent,
  config: AppConfig,
): HypermediaDocument<EventItemData> {
  return resourceDocument({
    type: "application-event",
    id: event.id,
    data: eventData(event),
    links: [
      link("self", `${config.issuerUrl}/events/${event.id}`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("collection", `${config.issuerUrl}/events`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
    ],
    actions: [],
  });
}

function eventData(event: ApplicationEvent): EventItemData {
  return {
    id: event.id,
    type: event.type,
    data: JSON.parse(event.dataJson) as Record<string, unknown>,
    created_at: event.createdAt,
    expires_at: event.expiresAt,
  };
}

function eventPageItem(
  event: ApplicationEvent,
  config: AppConfig,
): ApplicationEventPageItem {
  const data = eventData(event);
  return {
    id: data.id,
    href: `${config.issuerUrl}/events/${data.id}`,
    type: data.type,
    data: data.data,
    createdAt: data.created_at,
    expiresAt: data.expires_at,
  };
}

function eventPageHref(
  config: AppConfig,
  page: Pick<EventPageRequest, "pageSize" | "typeFilter">,
  cursor: string | null,
): string {
  const url = new URL(`${config.issuerUrl}/events`);
  url.searchParams.set("page_size", String(page.pageSize));
  if (page.typeFilter) url.searchParams.set("type", page.typeFilter);
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.toString();
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

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}
