import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";

const KEY_FILE_MAX_BYTES = 32 * 1024;
const JWKS_MAX_BYTES = 64 * 1024;
const UNIQUE_FILE_ATTEMPTS = 8;
const VALIDATION_MESSAGE = new TextEncoder().encode(
  "aittadb-signing-key-validation-v1",
);

export type SigningKeyFileRole = "candidate" | "rollback";
export type PublicSigningJwk = JsonWebKey & { kid: string };

export interface SigningKeyBundle {
  JWT_KEY_ID: string;
  JWT_PRIVATE_JWK: string;
  public_jwk: PublicSigningJwk;
}

export interface ValidatedSigningKeyBundle {
  kid: string;
  privateJwk: JsonWebKey;
  publicJwk: PublicSigningJwk;
  serialized: string;
}

export interface UniqueFileOptions {
  fileName?: (role: SigningKeyFileRole, attempt: number) => string;
}

export interface RotationFiles {
  rollbackPath: string;
  candidatePath: string;
  candidateKid: string;
}

export async function generateSigningKeyBundle(
  configuredKid?: string,
): Promise<ValidatedSigningKeyBundle> {
  const kid = configuredKid ?? randomUUID();
  assertKid(kid);
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const exportedPublicJwk = await crypto.subtle.exportKey(
    "jwk",
    keyPair.publicKey,
  );
  const publicJwk = {
    ...exportedPublicJwk,
    alg: "ES256",
    use: "sig",
    key_ops: ["verify"],
    ext: true,
    kid,
  } as PublicSigningJwk;
  return validateSigningKeyBundle(
    {
      JWT_KEY_ID: kid,
      JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
      public_jwk: publicJwk,
    },
    kid,
  );
}

export async function validateSigningKeyBundle(
  value: unknown,
  configuredKid?: string,
): Promise<ValidatedSigningKeyBundle> {
  if (!isRecord(value)) throw new Error("invalid_signing_key");
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "JWT_KEY_ID" ||
    keys[1] !== "JWT_PRIVATE_JWK" ||
    keys[2] !== "public_jwk"
  ) {
    throw new Error("invalid_signing_key");
  }

  const kid = value.JWT_KEY_ID;
  if (typeof kid !== "string") throw new Error("invalid_signing_key");
  assertKid(kid);
  if (configuredKid !== undefined && kid !== configuredKid) {
    throw new Error("invalid_signing_key");
  }
  if (typeof value.JWT_PRIVATE_JWK !== "string") {
    throw new Error("invalid_signing_key");
  }

  let privateJwk: unknown;
  try {
    privateJwk = JSON.parse(value.JWT_PRIVATE_JWK) as unknown;
  } catch {
    throw new Error("invalid_signing_key");
  }
  if (!isRecord(privateJwk) || !isRecord(value.public_jwk)) {
    throw new Error("invalid_signing_key");
  }

  validatePrivateJwk(privateJwk, kid);
  validatePublicJwk(value.public_jwk, kid);
  if (
    privateJwk.kty !== value.public_jwk.kty ||
    privateJwk.crv !== value.public_jwk.crv ||
    privateJwk.x !== value.public_jwk.x ||
    privateJwk.y !== value.public_jwk.y
  ) {
    throw new Error("invalid_signing_key");
  }

  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    value.public_jwk as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    VALIDATION_MESSAGE,
  );
  if (
    !(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature,
      VALIDATION_MESSAGE,
    ))
  ) {
    throw new Error("invalid_signing_key");
  }

  const publicJwk = value.public_jwk as unknown as PublicSigningJwk;
  const bundle: SigningKeyBundle = {
    JWT_KEY_ID: kid,
    JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
    public_jwk: publicJwk,
  };
  return {
    kid,
    privateJwk: privateJwk as JsonWebKey,
    publicJwk,
    serialized: `${JSON.stringify(bundle, null, 2)}\n`,
  };
}

export async function readProtectedSigningKeyFile(
  filePath: string,
  configuredKid?: string,
): Promise<ValidatedSigningKeyBundle> {
  let handle: FileHandle | undefined;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new Error("unprotected_signing_key");
    }
    if (stat.size <= 0 || stat.size > KEY_FILE_MAX_BYTES) {
      throw new Error("invalid_signing_key");
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(contents) > KEY_FILE_MAX_BYTES) {
      throw new Error("invalid_signing_key");
    }
    return await validateSigningKeyBundle(
      JSON.parse(contents) as unknown,
      configuredKid,
    );
  } catch {
    throw new Error("invalid_or_unprotected_signing_key");
  } finally {
    await handle?.close();
  }
}

export async function writeUniqueSigningKeyFile(
  directory: string,
  role: SigningKeyFileRole,
  bundle: ValidatedSigningKeyBundle,
  options: UniqueFileOptions = {},
): Promise<string> {
  const protectedDirectory = await ensureProtectedDirectory(directory);
  const validated = await validateSigningKeyBundle(
    JSON.parse(bundle.serialized) as unknown,
    bundle.kid,
  );

  for (let attempt = 0; attempt < UNIQUE_FILE_ATTEMPTS; attempt += 1) {
    const fileName =
      options.fileName?.(role, attempt) ?? defaultFileName(role, attempt);
    if (
      basename(fileName) !== fileName ||
      !/^jwt-signing-key-(?:candidate|rollback)-[A-Za-z0-9._-]+\.json$/.test(
        fileName,
      )
    ) {
      throw new Error("invalid_signing_key_filename");
    }
    const filePath = join(protectedDirectory, fileName);
    let handle: FileHandle | undefined;
    let created = false;
    try {
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      handle = await open(
        filePath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          noFollow,
        0o600,
      );
      created = true;
      await handle.writeFile(validated.serialized, { encoding: "utf8" });
      await handle.chmod(0o600);
      await handle.sync();
      const stat = await handle.stat();
      if ((stat.mode & 0o777) !== 0o600) {
        throw new Error("unprotected_signing_key");
      }
      await handle.close();
      handle = undefined;
      return filePath;
    } catch (error) {
      await handle?.close();
      if (created) await unlink(filePath).catch(() => undefined);
      if (isAlreadyExists(error)) continue;
      throw new Error("signing_key_write_failed");
    }
  }
  throw new Error("signing_key_file_exists");
}

export async function prepareSigningKeyRotation(args: {
  currentFile: string;
  currentKid: string;
  candidateKid?: string;
  directory: string;
  rollbackFileOptions?: UniqueFileOptions;
  candidateFileOptions?: UniqueFileOptions;
}): Promise<RotationFiles> {
  const current = await readProtectedSigningKeyFile(
    args.currentFile,
    args.currentKid,
  );
  const candidate = await generateSigningKeyBundle(args.candidateKid);
  const rollbackPath = await writeUniqueSigningKeyFile(
    args.directory,
    "rollback",
    current,
    args.rollbackFileOptions,
  );
  try {
    const candidatePath = await writeUniqueSigningKeyFile(
      args.directory,
      "candidate",
      candidate,
      args.candidateFileOptions,
    );
    return {
      rollbackPath,
      candidatePath,
      candidateKid: candidate.kid,
    };
  } catch {
    await unlink(rollbackPath).catch(() => undefined);
    throw new Error("signing_key_rotation_preparation_failed");
  }
}

export async function currentKeyMatchesJwks(args: {
  currentFile: string;
  configuredKid: string;
  jwksUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  try {
    const current = await readProtectedSigningKeyFile(
      args.currentFile,
      args.configuredKid,
    );
    const url = validJwksUrl(args.jwksUrl);
    const response = await (args.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) return false;
    const text = await readBoundedResponse(response, JWKS_MAX_BYTES);
    const document = JSON.parse(text) as unknown;
    if (!isRecord(document) || !Array.isArray(document.keys)) return false;
    const matches = document.keys.filter(
      (key): key is Record<string, unknown> =>
        isRecord(key) && key.kid === args.configuredKid,
    );
    return (
      matches.length === 1 &&
      publicJwkEquals(matches[0]!, current.publicJwk, args.configuredKid)
    );
  } catch {
    return false;
  }
}

async function ensureProtectedDirectory(directory: string): Promise<string> {
  const absolute = resolve(directory);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("invalid_signing_key_directory");
  }
  await chmod(absolute, 0o700);
  return absolute;
}

function defaultFileName(role: SigningKeyFileRole, attempt: number): string {
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, "");
  const suffix = randomBytes(12).toString("hex");
  return `jwt-signing-key-${role}-${timestamp}-${attempt}-${suffix}.json`;
}

function validatePrivateJwk(jwk: Record<string, unknown>, kid: string): void {
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    jwk.ext !== true ||
    !isCoordinate(jwk.x) ||
    !isCoordinate(jwk.y) ||
    !isCoordinate(jwk.d) ||
    !isExactKeyOps(jwk.key_ops, "sign") ||
    (jwk.alg !== undefined && jwk.alg !== "ES256") ||
    (jwk.use !== undefined && jwk.use !== "sig") ||
    (jwk.kid !== undefined && jwk.kid !== kid)
  ) {
    throw new Error("invalid_signing_key");
  }
}

function validatePublicJwk(jwk: Record<string, unknown>, kid: string): void {
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    jwk.ext !== true ||
    jwk.alg !== "ES256" ||
    jwk.use !== "sig" ||
    jwk.kid !== kid ||
    !isCoordinate(jwk.x) ||
    !isCoordinate(jwk.y) ||
    !isExactKeyOps(jwk.key_ops, "verify") ||
    "d" in jwk
  ) {
    throw new Error("invalid_signing_key");
  }
}

function publicJwkEquals(
  candidate: Record<string, unknown>,
  expected: JsonWebKey,
  kid: string,
): boolean {
  try {
    validatePublicJwk(candidate, kid);
  } catch {
    return false;
  }
  return (
    candidate.kty === expected.kty &&
    candidate.crv === expected.crv &&
    candidate.x === expected.x &&
    candidate.y === expected.y &&
    candidate.alg === expected.alg &&
    candidate.use === expected.use &&
    candidate.ext === expected.ext &&
    JSON.stringify(candidate.key_ops) === JSON.stringify(expected.key_ops)
  );
}

function isCoordinate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 32 && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

function isExactKeyOps(value: unknown, operation: "sign" | "verify"): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === operation;
}

function assertKid(value: string): void {
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(value)) {
    throw new Error("invalid_signing_key_id");
  }
}

function validJwksUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/.well-known/jwks.json"
  ) {
    throw new Error("invalid_jwks_url");
  }
  return url;
}

async function readBoundedResponse(
  response: Response,
  limit: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    throw new Error("jwks_too_large");
  }
  if (!response.body) throw new Error("invalid_jwks");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > limit) throw new Error("jwks_too_large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
