import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ADMIN_ACCESS_KEY_BYTES = 32;
export const ADMIN_ACCESS_KEY_HASH_SECRET = "ADMIN_ACCESS_KEY_HASH";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_SECRET_DIRECTORY = join(REPOSITORY_ROOT, ".secrets");

export interface AdminAccessKeyPaths {
  directory: string;
  plaintext: string;
  hash: string;
}

export interface AdminAccessKeyMaterial {
  plaintext: string;
  hash: string;
}

export const DEFAULT_ADMIN_ACCESS_KEY_PATHS: AdminAccessKeyPaths = {
  directory: DEFAULT_SECRET_DIRECTORY,
  plaintext: join(DEFAULT_SECRET_DIRECTORY, "admin-access-key.txt"),
  hash: join(DEFAULT_SECRET_DIRECTORY, "admin-access-key.sha256"),
};

export function createAdminAccessKey(
  entropy: Uint8Array = randomBytes(ADMIN_ACCESS_KEY_BYTES),
): string {
  if (entropy.byteLength !== ADMIN_ACCESS_KEY_BYTES) {
    throw new Error(
      `Admin access keys require ${ADMIN_ACCESS_KEY_BYTES} bytes`,
    );
  }
  return Buffer.from(entropy).toString("base64url");
}

export function hashAdminAccessKey(accessKey: string): string {
  return createHash("sha256").update(accessKey, "utf8").digest("base64url");
}

export function parseAdminAccessKeyArguments(args: string[]): {
  force: boolean;
} {
  if (args.length === 0) return { force: false };
  if (args.length === 1 && args[0] === "--force") return { force: true };
  throw new Error(
    "Usage: npm run admin-key:generate -- [--force] (force replaces existing local files)",
  );
}

export async function writeAdminAccessKeyFiles(
  paths: AdminAccessKeyPaths,
  material: AdminAccessKeyMaterial,
  force: boolean,
): Promise<void> {
  assertPathsShareDirectory(paths);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);

  if (!force) {
    await writeExclusive(paths, material);
    return;
  }

  await replaceFromStagedFiles(paths, material);
}

export function adminAccessKeyInstructions(
  paths: AdminAccessKeyPaths = DEFAULT_ADMIN_ACCESS_KEY_PATHS,
): string {
  const plaintextPath = relative(REPOSITORY_ROOT, paths.plaintext);
  const hashPath = relative(REPOSITORY_ROOT, paths.hash);
  return [
    "Generated local administrative access-key files with restrictive permissions.",
    `Plaintext key file: ${plaintextPath}`,
    `SHA-256 base64url hash file: ${hashPath}`,
    `Set the hosted secret ${ADMIN_ACCESS_KEY_HASH_SECRET} to the contents of the hash file.`,
    "No key material was printed.",
  ].join("\n");
}

export async function runAdminAccessKeyGenerator(
  args: string[],
): Promise<void> {
  const { force } = parseAdminAccessKeyArguments(args);
  const plaintext = createAdminAccessKey();
  const material = {
    plaintext,
    hash: hashAdminAccessKey(plaintext),
  };

  await writeAdminAccessKeyFiles(
    DEFAULT_ADMIN_ACCESS_KEY_PATHS,
    material,
    force,
  );
  process.stdout.write(`${adminAccessKeyInstructions()}\n`);
}

async function writeExclusive(
  paths: AdminAccessKeyPaths,
  material: AdminAccessKeyMaterial,
): Promise<void> {
  let plaintextCreated = false;
  try {
    await writeFile(paths.plaintext, `${material.plaintext}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    plaintextCreated = true;
    await writeFile(paths.hash, `${material.hash}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (plaintextCreated) await removeIfPresent(paths.plaintext);
    if (isAlreadyExistsError(error)) {
      throw new Error(
        "Local admin access-key files already exist; use --force only for an intentional replacement",
      );
    }
    throw error;
  }
}

async function replaceFromStagedFiles(
  paths: AdminAccessKeyPaths,
  material: AdminAccessKeyMaterial,
): Promise<void> {
  const suffix = `${process.pid}-${randomUUID()}.tmp`;
  const stagedPlaintext = `${paths.plaintext}.${suffix}`;
  const stagedHash = `${paths.hash}.${suffix}`;

  try {
    await writeFile(stagedPlaintext, `${material.plaintext}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(stagedHash, `${material.hash}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(stagedPlaintext, paths.plaintext);
    await rename(stagedHash, paths.hash);
    await chmod(paths.plaintext, 0o600);
    await chmod(paths.hash, 0o600);
  } finally {
    await Promise.all([
      removeIfPresent(stagedPlaintext),
      removeIfPresent(stagedHash),
    ]);
  }
}

function assertPathsShareDirectory(paths: AdminAccessKeyPaths): void {
  const expectedDirectory = resolve(paths.directory);
  if (
    dirname(resolve(paths.plaintext)) !== expectedDirectory ||
    dirname(resolve(paths.hash)) !== expectedDirectory
  ) {
    throw new Error("Admin access-key files must share their secret directory");
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;

if (invokedPath === import.meta.url) {
  runAdminAccessKeyGenerator(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : "Admin access-key generation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
