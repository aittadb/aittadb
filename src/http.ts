import { randomToken } from "./crypto";
import {
  HYPERMEDIA_API_VERSION,
  HYPERMEDIA_MEDIA_TYPE,
  action,
  link,
  negotiateHypermediaRepresentation,
  prefersVendorHypermedia,
  resourceDocument,
  type HypermediaAction,
  type HypermediaDocument,
  type HypermediaLink,
} from "./hypermedia";

const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  addSecurityHeaders(headers);
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function hypermediaJson<T>(
  request: Request,
  data: HypermediaDocument<T>,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set(
    "content-type",
    prefersVendorHypermedia(request)
      ? `${HYPERMEDIA_MEDIA_TYPE}; version=${HYPERMEDIA_API_VERSION}; charset=utf-8`
      : "application/json; charset=utf-8",
  );
  headers.set("aittadb-api-version", HYPERMEDIA_API_VERSION);
  headers.set("cache-control", "no-store");
  appendVary(headers, "Accept");
  addSecurityHeaders(headers);
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function formError(
  error: string,
  description?: string,
  status = 400,
): Response {
  return oauthError(error, description, status);
}

export function oauthError(
  error: string,
  description?: string,
  status = 400,
  controls: {
    links?: readonly HypermediaLink[];
    actions?: readonly HypermediaAction[];
  } = {},
): Response {
  return json(errorDocument(error, description, controls), {
    status,
    headers: { "aittadb-api-version": HYPERMEDIA_API_VERSION },
  });
}

/**
 * Render an application error using the selected compatible JSON media type.
 * OAuth protocol endpoints intentionally continue to use oauthError().
 */
export function hypermediaError(
  request: Request,
  error: string,
  description?: string,
  status = 400,
  controls: {
    links?: readonly HypermediaLink[];
    actions?: readonly HypermediaAction[];
  } = {},
): Response {
  return hypermediaJson(request, errorDocument(error, description, controls), {
    status,
  });
}

export function defaultHypermediaLinks(): HypermediaLink[] {
  return [
    link("service", "/", { type: HYPERMEDIA_MEDIA_TYPE }),
    link("session", "/session", { type: HYPERMEDIA_MEDIA_TYPE }),
    link("health", "/health", { type: HYPERMEDIA_MEDIA_TYPE }),
    link("privacy-policy", "/privacy", { type: HYPERMEDIA_MEDIA_TYPE }),
    link("documentation", "/docs", { type: "text/html" }),
    link("describedby", "/openapi.json", { type: "application/json" }),
    link("openid-configuration", "/.well-known/openid-configuration", {
      type: "application/json",
    }),
    link("jwks", "/.well-known/jwks.json", { type: "application/json" }),
  ];
}

export function defaultHypermediaActions(): HypermediaAction[] {
  return [action("open-service", "Open service", "GET", "/", { fields: [] })];
}

export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  appendVary(headers, "Accept");
  addSecurityHeaders(headers);
  return new Response(`<!doctype html>${body}`, { ...init, headers });
}

export function stylesheet(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/css; charset=utf-8");
  headers.set("cache-control", "no-store");
  addSecurityHeaders(headers);
  return new Response(body, { ...init, headers });
}

export function javascript(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/javascript; charset=utf-8");
  headers.set("cache-control", "no-store");
  addSecurityHeaders(headers);
  return new Response(body, { ...init, headers });
}

export function addSecurityHeaders(headers: Headers): void {
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
}

export async function readForm(
  request: Request,
  maxBytes = 16_384,
): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    throw new Error("unsupported_media_type");
  }
  const text = new TextDecoder().decode(
    await readBoundedBody(request.body, maxBytes),
  );
  return new URLSearchParams(text);
}

export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<ArrayBuffer> {
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - totalBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("request_too_large");
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const result = new ArrayBuffer(totalBytes);
  const bytes = new Uint8Array(result);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function redirect(location: string, status = 302): Response {
  const headers = new Headers({ location });
  headers.set("cache-control", "no-store");
  addSecurityHeaders(headers);
  return new Response(null, { status, headers });
}

export function cors(
  request: Request,
  allowedOrigins: readonly string[],
  canonicalOrigin?: string,
): Headers | Response {
  const origin = request.headers.get("origin");
  const headers = new Headers();
  if (!origin) return headers;
  if (isSameOrigin(request, canonicalOrigin)) return headers;
  if (!allowedOrigins.includes(origin))
    return oauthError("invalid_request", "Origin is not allowed", 403);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  headers.set("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "authorization,content-type");
  headers.set("access-control-expose-headers", "x-aittadb-storage-key");
  return headers;
}

export function requireSameOrigin(
  request: Request,
  canonicalOrigin?: string,
): boolean {
  return isSameOrigin(request, canonicalOrigin);
}

function isSameOrigin(request: Request, canonicalOrigin?: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  if (origin === "null") {
    return request.headers.get("sec-fetch-site") === "same-origin";
  }
  if (origin === new URL(request.url).origin) return true;
  if (!canonicalOrigin) return false;
  try {
    return origin === new URL(canonicalOrigin).origin;
  } catch {
    return false;
  }
}

export function parseBasicAuth(
  request: Request,
): { username: string; password: string } | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7);
}

export function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name) cookies.set(name, rest.join("="));
  }
  return cookies;
}

export function csrfCookie(value: string): string {
  return `aittadb_csrf=${value}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=900`;
}

export function csrfTokenForRequest(request: Request): string {
  const existing = parseCookies(request).get("aittadb_csrf");
  return existing && CSRF_TOKEN_PATTERN.test(existing)
    ? existing
    : randomToken(24);
}

export function csrfTokenMatches(
  request: Request,
  submittedValue: string | null,
): boolean {
  const cookie = parseCookies(request).get("aittadb_csrf");
  return Boolean(
    cookie &&
    submittedValue &&
    CSRF_TOKEN_PATTERN.test(cookie) &&
    CSRF_TOKEN_PATTERN.test(submittedValue) &&
    cookie === submittedValue,
  );
}

export function acceptsHtml(request: Request): boolean {
  return negotiateHypermediaRepresentation(request) === "html";
}

export function acceptsJson(request: Request): boolean {
  const representation = negotiateHypermediaRepresentation(request);
  return representation === "json" || representation === "hypermedia";
}

export function isJsonMediaType(value: string): boolean {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function appendVary(headers: Headers, value: string): void {
  const existing = (headers.get("vary") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!existing.some((part) => part.toLowerCase() === value.toLowerCase())) {
    existing.push(value);
  }
  headers.set("vary", existing.join(", "));
}

function errorDocument(
  error: string,
  description: string | undefined,
  controls: {
    links?: readonly HypermediaLink[];
    actions?: readonly HypermediaAction[];
  },
): HypermediaDocument<{
  error: string;
  error_description?: string;
}> & {
  error: string;
  error_description?: string;
} {
  const data = {
    error,
    ...(description ? { error_description: description } : {}),
  };
  return {
    ...data,
    ...resourceDocument({
      type: "error",
      data,
      links: controls.links ?? defaultHypermediaLinks(),
      actions: controls.actions ?? [],
    }),
  };
}
