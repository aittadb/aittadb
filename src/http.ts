export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
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
): Response {
  return json(
    {
      error,
      ...(description ? { error_description: description } : {}),
    },
    { status },
  );
}

export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  addSecurityHeaders(headers);
  return new Response(`<!doctype html>${body}`, { ...init, headers });
}

export function addSecurityHeaders(headers: Headers): void {
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set(
    "content-security-policy",
    "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
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
  const text = await request.text();
  if (text.length > maxBytes) throw new Error("request_too_large");
  return new URLSearchParams(text);
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
): Headers | Response {
  const origin = request.headers.get("origin");
  const headers = new Headers();
  if (!origin) return headers;
  if (origin === new URL(request.url).origin) return headers;
  if (!allowedOrigins.includes(origin))
    return oauthError("invalid_request", "Origin is not allowed", 403);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "authorization,content-type");
  return headers;
}

export function requireSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin;
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
  return `sab_csrf=${value}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=900`;
}
