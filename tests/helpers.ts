import type { RuntimeEnv } from "../src/types";

export async function testEnv(
  extra: Partial<RuntimeEnv> = {},
): Promise<RuntimeEnv> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  return {
    NODE_ENV: "test",
    ISSUER_URL: "https://broker.example.test",
    JWT_KEY_ID: "test-key",
    JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
    ADMIN_EMAILS: "admin@example.test",
    TEST_AUTH_EMAIL: "user@example.test",
    TEST_AUTH_FULL_NAME: "Test User",
    ...extra,
  };
}

export function form(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

export function cookieValue(response: Response, name: string): string {
  const cookie = response.headers.get("set-cookie") ?? "";
  const match = cookie.match(new RegExp(`${name}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${name}`);
  return match[1];
}
