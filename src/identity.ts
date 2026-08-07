import type { RuntimeEnv, UpstreamIdentity } from "./types";

const EMAIL_HEADER = "oai-authenticated-user-email";
const FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const FULL_NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";

export function readSitesIdentity(
  request: Request,
  env: RuntimeEnv,
): UpstreamIdentity | null {
  if (env.NODE_ENV === "test" && env.TEST_AUTH_EMAIL) {
    return {
      email: env.TEST_AUTH_EMAIL,
      fullName: env.TEST_AUTH_FULL_NAME ?? null,
      displayName: env.TEST_AUTH_FULL_NAME || env.TEST_AUTH_EMAIL,
    };
  }

  const email = request.headers.get(EMAIL_HEADER);
  if (!email || !isLikelyEmail(email)) return null;

  const rawFullName = request.headers.get(FULL_NAME_HEADER);
  const encoding = request.headers.get(FULL_NAME_ENCODING_HEADER);
  const fullName =
    rawFullName && encoding === PERCENT_ENCODED_UTF8
      ? safeDecode(rawFullName)
      : null;

  return {
    email,
    fullName,
    displayName: fullName || email,
  };
}

export function requireSitesIdentity(
  request: Request,
  env: RuntimeEnv,
): UpstreamIdentity | Response {
  const identity = readSitesIdentity(request, env);
  if (identity) return identity;

  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;
  const signIn = new URL("/signin-with-chatgpt", url.origin);
  signIn.searchParams.set("return_to", safeRelativeReturnPath(returnTo));
  return Response.redirect(signIn.toString(), 302);
}

export function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://sites-auth-broker.local");
    if (url.origin !== "https://sites-auth-broker.local") return "/";
    if (
      url.pathname === "/signin-with-chatgpt" ||
      url.pathname === "/signout-with-chatgpt"
    ) {
      return "/";
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}

function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function safeDecode(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}
