import { isCanonicalApplicationEventId } from "./application-events";
import { nowSeconds } from "./crypto";
import {
  bearerToken,
  hypermediaError,
  hypermediaJson,
  oauthError,
} from "./http";
import {
  HYPERMEDIA_MEDIA_TYPE,
  link,
  resourceDocument,
  type HypermediaDocument,
} from "./hypermedia";
import { parseScopes, verifyAccessToken } from "./oauth";
import type {
  AppConfig,
  ApplicationEvent,
  AuthStore,
  ClientView,
} from "./types";

const MAX_BEARER_TOKEN_LENGTH = 16_384;

interface ApplicationEventPrincipal {
  userId: string;
  client: ClientView;
}

export interface ApplicationEventData {
  id: string;
  type: string;
  data: Record<string, unknown>;
  created_at: number;
  expires_at: number;
}

export async function applicationEventItemEndpoint(
  request: Request,
  id: string,
  store: AuthStore,
  config: AppConfig,
): Promise<Response> {
  if (!config.features.events) {
    return hypermediaError(
      request,
      "feature_unavailable",
      "Events is disabled for this deployment",
      503,
    );
  }
  const principal = await requireApplicationEventRead(request, config, store);
  if (principal instanceof Response) return principal;
  if (!isCanonicalApplicationEventId(id)) {
    return applicationEventNotFound(request, config);
  }

  const event = await store.getApplicationEvent(
    principal.userId,
    principal.client.id,
    id,
  );
  if (!event || event.expiresAt <= nowSeconds()) {
    return applicationEventNotFound(request, config);
  }
  return hypermediaJson(request, applicationEventDocument(event, config));
}

export function applicationEventDocument(
  event: ApplicationEvent,
  config: AppConfig,
): HypermediaDocument<ApplicationEventData> {
  const href = `${config.issuerUrl}/events/${event.id}`;
  return resourceDocument({
    type: "application-event",
    id: event.id,
    data: {
      id: event.id,
      type: event.type,
      data: JSON.parse(event.dataJson) as Record<string, unknown>,
      created_at: event.createdAt,
      expires_at: event.expiresAt,
    },
    links: [
      link("self", href, { type: HYPERMEDIA_MEDIA_TYPE }),
      link("collection", `${config.issuerUrl}/events`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
    ],
    actions: [],
  });
}

export function isApplicationEventData(
  value: unknown,
): value is ApplicationEventData {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ApplicationEventData>;
  return (
    typeof candidate.id === "string" &&
    isCanonicalApplicationEventId(candidate.id) &&
    typeof candidate.type === "string" &&
    candidate.data !== null &&
    typeof candidate.data === "object" &&
    !Array.isArray(candidate.data) &&
    Number.isSafeInteger(candidate.created_at) &&
    Number.isSafeInteger(candidate.expires_at)
  );
}

function applicationEventNotFound(
  request: Request,
  config: AppConfig,
): Response {
  return hypermediaError(request, "not_found", "Event not found", 404, {
    links: [
      link("collection", `${config.issuerUrl}/events`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
    ],
  });
}

async function requireApplicationEventRead(
  request: Request,
  config: AppConfig,
  store: AuthStore,
): Promise<ApplicationEventPrincipal | Response> {
  const token = bearerToken(request);
  if (!token) return oauthError("invalid_token", "Bearer token required", 401);
  if (token.length > MAX_BEARER_TOKEN_LENGTH) {
    return oauthError("invalid_token", "Invalid token", 401);
  }
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

    if (client.type === "service") {
      if (
        verified.claims.subject_type !== "service" ||
        verified.claims.sub !== client.id ||
        !(await store.hasServicePrincipal(client.id))
      ) {
        return oauthError("invalid_token", "Invalid token", 401);
      }
      return { userId: client.id, client };
    }

    if (verified.claims.subject_type !== undefined) {
      return oauthError("invalid_token", "Invalid token", 401);
    }
    const user = await store.getUser(verified.claims.sub);
    return user
      ? { userId: user.id, client }
      : oauthError("invalid_token", "Invalid token", 401);
  } catch {
    return oauthError("invalid_token", "Invalid token", 401);
  }
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
