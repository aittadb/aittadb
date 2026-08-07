import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ADMIN_ACCESS_KEY_BYTES,
  ADMIN_ACCESS_KEY_HASH_SECRET,
  adminAccessKeyInstructions,
  createAdminAccessKey,
  hashAdminAccessKey,
  parseAdminAccessKeyArguments,
  writeAdminAccessKeyFiles,
  type AdminAccessKeyPaths,
} from "../../scripts/generate-admin-access-key";

test("admin access-key encoding and hashing use fixed test input", () => {
  const accessKey = createAdminAccessKey(
    new Uint8Array(ADMIN_ACCESS_KEY_BYTES).fill(0xa5),
  );

  assert.equal(accessKey.length, 43);
  assert.match(accessKey, /^[A-Za-z0-9_-]+$/);
  assert.equal(
    hashAdminAccessKey("fixed-unit-test-input"),
    "_aU3wXvxNBiGNe8RYs_fqK5Z8RDRZ2SkDf0IZCW9lvI",
  );
  assert.throws(
    () => createAdminAccessKey(new Uint8Array(ADMIN_ACCESS_KEY_BYTES - 1)),
    /require 32 bytes/,
  );
});

test("admin access-key arguments require an explicit replacement flag", () => {
  assert.deepEqual(parseAdminAccessKeyArguments([]), { force: false });
  assert.deepEqual(parseAdminAccessKeyArguments(["--force"]), { force: true });
  assert.throws(
    () => parseAdminAccessKeyArguments(["--replace"]),
    /Usage: npm run admin-key:generate/,
  );
});

test("admin access-key files are private and reject accidental overwrite", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aittadb-admin-key-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const paths: AdminAccessKeyPaths = {
    directory: join(root, ".secrets"),
    plaintext: join(root, ".secrets", "admin-access-key.txt"),
    hash: join(root, ".secrets", "admin-access-key.sha256"),
  };
  const fixture = {
    plaintext: "fixed-test-fixture-not-a-generated-key",
    hash: "fixed-test-fixture-not-a-generated-hash",
  };

  await writeAdminAccessKeyFiles(paths, fixture, false);

  assert.equal((await stat(paths.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.plaintext)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.hash)).mode & 0o777, 0o600);
  await assert.rejects(
    writeAdminAccessKeyFiles(paths, fixture, false),
    /already exist/,
  );
  await writeAdminAccessKeyFiles(paths, fixture, true);
});

test("admin access-key instructions identify only paths and hosted secret", () => {
  const paths = {
    directory: "/tmp/fixed-fixture/.secrets",
    plaintext: "/tmp/fixed-fixture/.secrets/admin-access-key.txt",
    hash: "/tmp/fixed-fixture/.secrets/admin-access-key.sha256",
  };
  const instructions = adminAccessKeyInstructions(paths);

  assert.match(instructions, new RegExp(ADMIN_ACCESS_KEY_HASH_SECRET));
  assert.match(instructions, /admin-access-key\.sha256/);
  assert.match(instructions, /No key material was printed/);
  assert.doesNotMatch(instructions, /fixed-unit-test-input/);
});
