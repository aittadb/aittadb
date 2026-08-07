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
      _links: defaultHypermediaLinks(),
      actions: defaultHypermediaActions(),
    },
    { status },
  );
}

export function defaultHypermediaLinks(): Record<
  string,
  { href: string; type?: string }
> {
  return {
    service: { href: "/", type: "text/html" },
    health: { href: "/health", type: "application/json" },
    docs: { href: "/docs", type: "text/html" },
    openapi: { href: "/openapi.json", type: "application/json" },
    oidcConfiguration: {
      href: "/.well-known/openid-configuration",
      type: "application/json",
    },
    jwks: { href: "/.well-known/jwks.json", type: "application/json" },
  };
}

export function defaultHypermediaActions(): Record<string, unknown> {
  return {
    authorize: {
      method: "GET",
      href: "/authorize",
      parameters: [
        "response_type",
        "client_id",
        "redirect_uri",
        "scope",
        "state",
        "nonce",
        "code_challenge",
        "code_challenge_method",
      ],
    },
    deviceAuthorization: {
      method: "POST",
      href: "/oauth/device_authorization",
      encoding: "application/x-www-form-urlencoded",
      parameters: ["client_id", "scope"],
    },
    token: {
      method: "POST",
      href: "/oauth/token",
      encoding: "application/x-www-form-urlencoded",
      parameters: ["grant_type"],
    },
    revoke: {
      method: "POST",
      href: "/oauth/revoke",
      encoding: "application/x-www-form-urlencoded",
      parameters: ["token", "token_type_hint"],
    },
    introspect: {
      method: "POST",
      href: "/oauth/introspect",
      encoding: "application/x-www-form-urlencoded",
      parameters: ["token", "token_type_hint"],
    },
  };
}

export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
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

export function addSecurityHeaders(headers: Headers): void {
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set(
    "content-security-policy",
    "default-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
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
  headers.set("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "authorization,content-type");
  return headers;
}

export function requireSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  if (origin === "null") {
    return request.headers.get("sec-fetch-site") === "same-origin";
  }
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

export function acceptsHtml(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept) return false;
  const ranges = accept
    .split(",")
    .map((part) => {
      const [type, ...params] = part.trim().split(";");
      const q = params
        .map((param) => param.trim())
        .find((param) => param.startsWith("q="));
      return {
        type: type.toLowerCase(),
        q: q ? Number.parseFloat(q.slice(2)) : 1,
      };
    })
    .filter((range) => Number.isFinite(range.q) && range.q > 0);

  const html = ranges.find((range) => range.type === "text/html");
  if (!html) return false;

  const json = ranges.find(
    (range) =>
      range.type === "application/json" ||
      range.type === "application/*" ||
      range.type === "*/*",
  );
  return !json || html.q >= json.q;
}
