import { createAittaDBWithStore, type AittaDBApp } from "../src/handler";
import type { UpstreamIdentityProvider } from "../src/identity";
import type { AuthStore, RuntimeEnv, UpstreamIdentity } from "../src/types";

const DEFAULT_TEST_IDENTITY: UpstreamIdentity = {
  email: "user@example.test",
  fullName: "Test User",
  displayName: "Test User",
};

class MemoryR2Object {
  constructor(
    private readonly body: Uint8Array,
    readonly httpMetadata?: { contentType?: string },
  ) {}

  async arrayBuffer(): Promise<ArrayBuffer> {
    const copy = new Uint8Array(this.body.byteLength);
    copy.set(this.body);
    return copy.buffer;
  }
}

export class MemoryR2Bucket implements R2Bucket {
  objects = new Map<
    string,
    {
      body: Uint8Array;
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  >();

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown> {
    const body = await toBytes(value);
    this.objects.set(key, {
      body,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
    });
    return {};
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return new MemoryR2Object(object.body, object.httpMetadata);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

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
    ISSUER_URL: "https://aittadb.example.test",
    JWT_KEY_ID: "test-key",
    JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
    BUCKET: new MemoryR2Bucket(),
    ...extra,
  };
}

export function testIdentityProvider(
  identity: UpstreamIdentity | null = DEFAULT_TEST_IDENTITY,
): UpstreamIdentityProvider {
  return {
    read: () => identity,
  };
}

export function createTestAittaDB(
  env: RuntimeEnv,
  store: AuthStore | null,
  identity: UpstreamIdentity | null = DEFAULT_TEST_IDENTITY,
): AittaDBApp {
  return createAittaDBWithStore(
    env,
    store,
    undefined,
    undefined,
    testIdentityProvider(identity),
  );
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

async function toBytes(
  value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(await new Response(value).arrayBuffer());
}
