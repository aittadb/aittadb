import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { runSigningKeyCli } from "../../scripts/signing-key-cli";
import {
  generateSigningKeyBundle,
  prepareSigningKeyRotation,
  readProtectedSigningKeyFile,
  validateSigningKeyBundle,
  writeUniqueSigningKeyFile,
  type ValidatedSigningKeyBundle,
} from "../../scripts/signing-key-operations";

test("generated ES256 bundles validate required members, kid, and sign/verify consistency", async () => {
  const generated = await generateSigningKeyBundle("generated-key");
  assert.equal(generated.kid, "generated-key");
  assert.equal(generated.privateJwk.kty, "EC");
  assert.equal(generated.privateJwk.crv, "P-256");
  assert.equal(typeof generated.privateJwk.d, "string");
  assert.equal(generated.publicJwk.kid, "generated-key");
  assert.equal(generated.publicJwk.alg, "ES256");
  assert.equal("d" in generated.publicJwk, false);

  const validated = await validateSigningKeyBundle(
    JSON.parse(generated.serialized) as unknown,
    "generated-key",
  );
  assert.equal(validated.kid, "generated-key");
});

test("validation rejects malformed, missing, inconsistent, and wrong-kid key bundles", async () => {
  const first = await generateSigningKeyBundle("first-key");
  const second = await generateSigningKeyBundle("second-key");
  const missingPrivateMember = JSON.parse(first.serialized) as Record<
    string,
    unknown
  >;
  const privateJwk = JSON.parse(
    String(missingPrivateMember.JWT_PRIVATE_JWK),
  ) as Record<string, unknown>;
  delete privateJwk.d;
  missingPrivateMember.JWT_PRIVATE_JWK = JSON.stringify(privateJwk);

  const mismatchedPair = JSON.parse(first.serialized) as Record<
    string,
    unknown
  >;
  const secondDocument = JSON.parse(second.serialized) as Record<
    string,
    unknown
  >;
  const secondPrivate = JSON.parse(
    String(secondDocument.JWT_PRIVATE_JWK),
  ) as JsonWebKey;
  mismatchedPair.JWT_PRIVATE_JWK = JSON.stringify(secondPrivate);

  await assert.rejects(() => validateSigningKeyBundle({}, "first-key"));
  await assert.rejects(() =>
    validateSigningKeyBundle(missingPrivateMember, "first-key"),
  );
  await assert.rejects(() =>
    validateSigningKeyBundle(mismatchedPair, "first-key"),
  );
  await assert.rejects(() =>
    validateSigningKeyBundle(
      JSON.parse(first.serialized) as unknown,
      "wrong-key",
    ),
  );
});

test("key files are unique, ignored-directory-ready, mode 0600, and never clobbered", async (t) => {
  const root = await temporaryDirectory(t);
  const directory = join(root, ".secrets", "signing-keys");
  const bundle = await generateSigningKeyBundle("file-key");
  const fileName = "jwt-signing-key-candidate-fixed.json";
  const created = await writeUniqueSigningKeyFile(
    directory,
    "candidate",
    bundle,
    { fileName: () => fileName },
  );
  assert.equal((await lstat(created)).mode & 0o777, 0o600);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);

  const original = await readFile(created, "utf8");
  await assert.rejects(() =>
    writeUniqueSigningKeyFile(directory, "candidate", bundle, {
      fileName: () => fileName,
    }),
  );
  assert.equal(await readFile(created, "utf8"), original);
});

test("protected reads reject missing, non-0600, and symbolic-link key files", async (t) => {
  const root = await temporaryDirectory(t);
  const bundle = await generateSigningKeyBundle("protected-key");
  const current = join(root, "current.json");
  await writeFile(current, bundle.serialized, { flag: "wx", mode: 0o600 });

  await assert.rejects(() =>
    readProtectedSigningKeyFile(join(root, "missing.json"), "protected-key"),
  );
  await chmod(current, 0o640);
  await assert.rejects(() =>
    readProtectedSigningKeyFile(current, "protected-key"),
  );

  await chmod(current, 0o700);
  await assert.rejects(() =>
    readProtectedSigningKeyFile(current, "protected-key"),
  );

  await chmod(current, 0o600);
  const linked = join(root, "linked.json");
  await symlink(current, linked);
  await assert.rejects(() =>
    readProtectedSigningKeyFile(linked, "protected-key"),
  );
});

test("rotation preparation creates protected rollback and candidate files without changing current", async (t) => {
  const root = await temporaryDirectory(t);
  const directory = join(root, ".secrets", "signing-keys");
  const currentBundle = await generateSigningKeyBundle("current-key");
  const currentFile = await writeCurrentFile(root, currentBundle);
  const original = await readFile(currentFile, "utf8");

  const result = await prepareSigningKeyRotation({
    currentFile,
    currentKid: "current-key",
    candidateKid: "candidate-key",
    directory,
    rollbackFileOptions: {
      fileName: () => "jwt-signing-key-rollback-fixed.json",
    },
    candidateFileOptions: {
      fileName: () => "jwt-signing-key-candidate-fixed.json",
    },
  });

  assert.equal(result.candidateKid, "candidate-key");
  assert.equal((await lstat(result.rollbackPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(result.candidatePath)).mode & 0o777, 0o600);
  assert.equal(
    (await readProtectedSigningKeyFile(result.rollbackPath, "current-key")).kid,
    "current-key",
  );
  assert.equal(
    (await readProtectedSigningKeyFile(result.candidatePath, "candidate-key"))
      .kid,
    "candidate-key",
  );
  assert.equal(await readFile(currentFile, "utf8"), original);
});

test("incomplete rotation preparation cleans its new rollback and preserves a collision", async (t) => {
  const root = await temporaryDirectory(t);
  const directory = join(root, ".secrets", "signing-keys");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const currentBundle = await generateSigningKeyBundle("current-key");
  const currentFile = await writeCurrentFile(root, currentBundle);
  const rollbackName = "jwt-signing-key-rollback-fixed.json";
  const collisionName = "jwt-signing-key-candidate-collision.json";
  const collisionPath = join(directory, collisionName);
  await writeFile(collisionPath, "preserve-existing-file\n", {
    flag: "wx",
    mode: 0o600,
  });

  await assert.rejects(() =>
    prepareSigningKeyRotation({
      currentFile,
      currentKid: "current-key",
      candidateKid: "candidate-key",
      directory,
      rollbackFileOptions: { fileName: () => rollbackName },
      candidateFileOptions: { fileName: () => collisionName },
    }),
  );
  await assert.rejects(() => lstat(join(directory, rollbackName)));
  assert.equal(
    await readFile(collisionPath, "utf8"),
    "preserve-existing-file\n",
  );
});

test("generate, prepare, and validate command output never discloses private material", async (t) => {
  const root = await temporaryDirectory(t);
  const directory = join(root, ".secrets", "signing-keys");
  const generatedOutput: string[] = [];
  const generatedErrors: string[] = [];
  const generatedStatus = await runSigningKeyCli(
    ["generate", "--kid", "cli-current-key"],
    {
      cwd: root,
      keyDirectory: directory,
      isIgnored: () => true,
      stdout: (line) => generatedOutput.push(line),
      stderr: (line) => generatedErrors.push(line),
    },
  );
  assert.equal(generatedStatus, 0);
  assert.equal(generatedOutput.length, 2);
  assert.equal(generatedErrors.length, 0);
  const candidatePath = resolve(
    root,
    generatedOutput[0]!.slice("candidate=".length),
  );
  const generated = await readProtectedSigningKeyFile(
    candidatePath,
    "cli-current-key",
  );
  assertNoPrivateOutput(generatedOutput, generatedErrors, generated);

  const validationOutput: string[] = [];
  assert.equal(
    await runSigningKeyCli(
      ["validate", "--key-file", candidatePath, "--kid", "cli-current-key"],
      { cwd: root, stdout: (line) => validationOutput.push(line) },
    ),
    0,
  );
  assert.deepEqual(validationOutput, ["valid"]);

  const rotationOutput: string[] = [];
  const rotationErrors: string[] = [];
  assert.equal(
    await runSigningKeyCli(
      [
        "prepare-rotation",
        "--current-file",
        candidatePath,
        "--current-kid",
        "cli-current-key",
        "--candidate-kid",
        "cli-next-key",
      ],
      {
        cwd: root,
        keyDirectory: directory,
        isIgnored: () => true,
        stdout: (line) => rotationOutput.push(line),
        stderr: (line) => rotationErrors.push(line),
      },
    ),
    0,
  );
  assert.equal(rotationOutput.length, 3);
  assert.equal(rotationErrors.length, 0);
  assertNoPrivateOutput(rotationOutput, rotationErrors, generated);
});

test("generation fails before key creation when the destination is not ignored", async (t) => {
  const root = await temporaryDirectory(t);
  const directory = join(root, "tracked-output");
  const output: string[] = [];
  const errors: string[] = [];
  assert.equal(
    await runSigningKeyCli(["generate"], {
      cwd: root,
      keyDirectory: directory,
      isIgnored: () => false,
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    }),
    1,
  );
  assert.deepEqual(output, []);
  assert.deepEqual(errors, ["Signing-key operation failed."]);
  await assert.rejects(() => lstat(directory));
});

test("validate command fails closed for missing, malformed, and wrong-kid files", async (t) => {
  const root = await temporaryDirectory(t);
  const malformed = join(root, "malformed.json");
  await writeFile(malformed, "not-json\n", { flag: "wx", mode: 0o600 });

  for (const filePath of [join(root, "missing.json"), malformed]) {
    const output: string[] = [];
    assert.equal(
      await runSigningKeyCli(
        ["validate", "--key-file", filePath, "--kid", "expected-key"],
        { cwd: root, stdout: (line) => output.push(line) },
      ),
      1,
    );
    assert.deepEqual(output, ["invalid"]);
  }

  const bundle = await generateSigningKeyBundle("actual-key");
  const current = await writeCurrentFile(root, bundle);
  const output: string[] = [];
  assert.equal(
    await runSigningKeyCli(
      ["validate", "--key-file", current, "--kid", "wrong-key"],
      { cwd: root, stdout: (line) => output.push(line) },
    ),
    1,
  );
  assert.deepEqual(output, ["invalid"]);
});

test("JWKS preflight returns only match or non-match for success and failures", async (t) => {
  const root = await temporaryDirectory(t);
  const currentBundle = await generateSigningKeyBundle("current-key");
  const currentFile = await writeCurrentFile(root, currentBundle);
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const matchingFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(JSON.stringify({ keys: [currentBundle.publicJwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const matchingOutput: string[] = [];
  assert.equal(
    await runSigningKeyCli(
      [
        "preflight",
        "--current-file",
        currentFile,
        "--kid",
        "current-key",
        "--jwks-url",
        "https://issuer.example/.well-known/jwks.json",
      ],
      {
        cwd: root,
        fetchImpl: matchingFetch,
        stdout: (line) => matchingOutput.push(line),
      },
    ),
    0,
  );
  assert.deepEqual(matchingOutput, ["match"]);
  assert.equal(requestedUrl, "https://issuer.example/.well-known/jwks.json");
  assert.equal(requestedInit?.body, undefined);
  assert.deepEqual(requestedInit?.headers, { accept: "application/json" });

  const other = await generateSigningKeyBundle("other-key");
  const nonMatchingPublic = { ...other.publicJwk, kid: "current-key" };
  const failures: Array<() => Promise<Response>> = [
    async () =>
      new Response(JSON.stringify({ keys: [nonMatchingPublic] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    async () =>
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    async () =>
      new Response(JSON.stringify({ keys: [currentBundle.publicJwk] }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    async () =>
      new Response(
        JSON.stringify({
          keys: [
            {
              ...currentBundle.publicJwk,
              d: currentBundle.privateJwk.d,
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  ];

  for (const fetchImpl of failures) {
    const output: string[] = [];
    const errors: string[] = [];
    assert.equal(
      await runSigningKeyCli(
        [
          "preflight",
          "--current-file",
          currentFile,
          "--kid",
          "current-key",
          "--jwks-url",
          "https://issuer.example/.well-known/jwks.json",
        ],
        {
          cwd: root,
          fetchImpl,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
        },
      ),
      1,
    );
    assert.deepEqual(output, ["non-match"]);
    assert.deepEqual(errors, []);
  }

  await chmod(currentFile, 0o644);
  const unprotectedOutput: string[] = [];
  assert.equal(
    await runSigningKeyCli(
      [
        "preflight",
        "--current-file",
        currentFile,
        "--kid",
        "current-key",
        "--jwks-url",
        "https://issuer.example/.well-known/jwks.json",
      ],
      {
        cwd: root,
        fetchImpl: matchingFetch,
        stdout: (line) => unprotectedOutput.push(line),
      },
    ),
    1,
  );
  assert.deepEqual(unprotectedOutput, ["non-match"]);
});

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aittadb-signing-key-test-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeCurrentFile(
  root: string,
  bundle: ValidatedSigningKeyBundle,
): Promise<string> {
  const filePath = join(root, `current-${bundle.kid}.json`);
  await writeFile(filePath, bundle.serialized, { flag: "wx", mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

function assertNoPrivateOutput(
  output: readonly string[],
  errors: readonly string[],
  bundle: ValidatedSigningKeyBundle,
): void {
  const combined = [...output, ...errors].join("\n");
  assert.equal(combined.includes(String(bundle.privateJwk.d)), false);
  assert.equal(combined.includes("JWT_PRIVATE_JWK"), false);
  assert.equal(combined.includes('"d"'), false);
}
