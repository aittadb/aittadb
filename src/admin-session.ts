import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEquals,
  randomToken,
  sha256,
} from "./crypto";
import type { AppConfig } from "./types";

const ADMIN_COOKIE = "aittadb_admin_session";
const ADMIN_SESSION_TTL_SECONDS = 15 * 60;

interface AdminSessionPayload {
  v: 1;
  sub: string;
  exp: number;
  nonce: string;
}

export async function verifyAdminAccessKey(
  value: string,
  config: AppConfig,
): Promise<boolean> {
  if (!value || !config.adminAccessKeyHash) return false;
  return constantTimeEquals(await sha256(value), config.adminAccessKeyHash);
}

export async function issueAdminSession(
  subject: string,
  config: AppConfig,
  now: number,
): Promise<{ token: string; cookie: string }> {
  if (!config.adminAccessKeyHash) throw new Error("admin_key_unavailable");
  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        sub: subject,
        exp: now + ADMIN_SESSION_TTL_SECONDS,
        nonce: randomToken(16),
      } satisfies AdminSessionPayload),
    ),
  );
  const signature = await sign(payload, config.adminAccessKeyHash);
  const token = `${payload}.${base64UrlEncode(signature)}`;
  return {
    token,
    cookie: `${ADMIN_COOKIE}=${token}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${ADMIN_SESSION_TTL_SECONDS}`,
  };
}

export async function hasValidAdminSession(
  request: Request,
  subject: string,
  config: AppConfig,
  now: number,
): Promise<boolean> {
  if (!config.adminAccessKeyHash) return false;
  const token = cookieValue(request, ADMIN_COOKIE);
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return false;
  try {
    const key = await hmacKey(config.adminAccessKeyHash);
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        ownedBuffer(base64UrlDecode(signature)),
        ownedBuffer(new TextEncoder().encode(payload)),
      ))
    ) {
      return false;
    }
    const parsed = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payload)),
    ) as Partial<AdminSessionPayload>;
    return (
      parsed.v === 1 &&
      parsed.sub === subject &&
      typeof parsed.exp === "number" &&
      parsed.exp > now &&
      typeof parsed.nonce === "string" &&
      parsed.nonce.length >= 20
    );
  } catch {
    return false;
  }
}

async function sign(payload: string, keyHash: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(keyHash),
      ownedBuffer(new TextEncoder().encode(payload)),
    ),
  );
}

async function hmacKey(keyHash: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    ownedBuffer(base64UrlDecode(keyHash)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function cookieValue(request: Request, name: string): string {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [candidate, ...value] = part.trim().split("=");
    if (candidate === name) return value.join("=");
  }
  return "";
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
