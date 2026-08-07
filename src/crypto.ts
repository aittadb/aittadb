export interface JwtClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  nbf?: number;
  jti: string;
  scope?: string;
  nonce?: string;
  email?: string;
  name?: string;
  token_use?: "access" | "id";
  [key: string]: unknown;
}

export interface VerifiedJwt {
  header: { alg: string; kid: string; typ?: string };
  claims: JwtClaims;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function randomToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64UrlEncode(data);
}

export function randomUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const data = new Uint8Array(8);
  crypto.getRandomValues(data);
  return Array.from(data, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function uuid(): string {
  return crypto.randomUUID();
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

export async function constantTimeEquals(
  left: string,
  right: string,
): Promise<boolean> {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  await crypto.subtle.digest("SHA-256", leftBytes);
  return diff === 0;
}

export async function verifyPkceS256(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const actual = await sha256(verifier);
  return constantTimeEquals(actual, challenge);
}

export async function signJwt(
  claims: JwtClaims,
  privateJwk: JsonWebKey,
  kid: string,
): Promise<string> {
  const header = { alg: "ES256", kid, typ: "JWT" };
  const encodedHeader = base64UrlEncodeJson(header);
  const encodedClaims = base64UrlEncodeJson(claims);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyJwt(
  token: string,
  publicJwks: readonly JsonWebKey[],
  expected: { issuer: string; audience: string; now: number },
): Promise<VerifiedJwt> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid_token");
  const header = parseJsonPart<{ alg: string; kid: string; typ?: string }>(
    parts[0],
  );
  if (header.alg !== "ES256") throw new Error("unsupported_algorithm");
  const jwk = publicJwks.find(
    (candidate) =>
      (candidate as JsonWebKey & { kid?: string }).kid === header.kid,
  );
  if (!jwk) throw new Error("unknown_key");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64UrlDecode(parts[2]) as BufferSource,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new Error("invalid_signature");

  const claims = parseJsonPart<JwtClaims>(parts[1]);
  if (claims.iss !== expected.issuer) throw new Error("invalid_issuer");
  if (claims.aud !== expected.audience) throw new Error("invalid_audience");
  if (typeof claims.exp !== "number" || claims.exp <= expected.now)
    throw new Error("expired_token");
  if (typeof claims.iat !== "number" || claims.iat > expected.now + 60)
    throw new Error("invalid_iat");
  if (typeof claims.nbf === "number" && claims.nbf > expected.now)
    throw new Error("not_before");
  return { header, claims };
}

export function publicJwk(privateJwk: JsonWebKey, kid: string): JsonWebKey {
  return {
    kty: privateJwk.kty,
    crv: privateJwk.crv,
    x: privateJwk.x,
    y: privateJwk.y,
    alg: "ES256",
    use: "sig",
    key_ops: ["verify"],
    ext: true,
    kid,
  } as JsonWebKey;
}

export function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function parseJsonPart<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(value))) as T;
}
