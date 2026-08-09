import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";

import {
  currentKeyMatchesJwks,
  generateSigningKeyBundle,
  prepareSigningKeyRotation,
  readProtectedSigningKeyFile,
  writeUniqueSigningKeyFile,
} from "./signing-key-operations";

export interface SigningKeyCliDependencies {
  cwd?: string;
  keyDirectory?: string;
  fetchImpl?: typeof fetch;
  isIgnored?: (path: string, cwd: string) => boolean;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function runSigningKeyCli(
  argv: readonly string[],
  dependencies: SigningKeyCliDependencies = {},
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const keyDirectory =
    dependencies.keyDirectory ?? resolve(cwd, ".secrets/signing-keys");
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const command = argv[0];

  if (command === "validate") {
    try {
      const options = parseOptions(argv.slice(1), ["key-file", "kid"]);
      await readProtectedSigningKeyFile(
        resolve(cwd, requireOption(options, "key-file")),
        requireOption(options, "kid"),
      );
      stdout("valid");
      return 0;
    } catch {
      stdout("invalid");
      return 1;
    }
  }

  if (command === "preflight") {
    try {
      const options = parseOptions(argv.slice(1), [
        "current-file",
        "kid",
        "jwks-url",
      ]);
      const match = await currentKeyMatchesJwks({
        currentFile: resolve(cwd, requireOption(options, "current-file")),
        configuredKid: requireOption(options, "kid"),
        jwksUrl: requireOption(options, "jwks-url"),
        fetchImpl: dependencies.fetchImpl,
      });
      stdout(match ? "match" : "non-match");
      return match ? 0 : 1;
    } catch {
      stdout("non-match");
      return 1;
    }
  }

  try {
    if (command === "generate") {
      const options = parseOptions(argv.slice(1), ["kid"]);
      requireIgnoredOutput(keyDirectory, cwd, dependencies.isIgnored);
      const candidate = await generateSigningKeyBundle(options.get("kid"));
      const candidatePath = await writeUniqueSigningKeyFile(
        keyDirectory,
        "candidate",
        candidate,
      );
      stdout(`candidate=${displayPath(candidatePath, cwd)}`);
      stdout(`kid=${candidate.kid}`);
      return 0;
    }

    if (command === "prepare-rotation") {
      const options = parseOptions(argv.slice(1), [
        "current-file",
        "current-kid",
        "candidate-kid",
      ]);
      requireIgnoredOutput(keyDirectory, cwd, dependencies.isIgnored);
      const result = await prepareSigningKeyRotation({
        currentFile: resolve(cwd, requireOption(options, "current-file")),
        currentKid: requireOption(options, "current-kid"),
        candidateKid: options.get("candidate-kid"),
        directory: keyDirectory,
      });
      stdout(`rollback=${displayPath(result.rollbackPath, cwd)}`);
      stdout(`candidate=${displayPath(result.candidatePath, cwd)}`);
      stdout(`candidate_kid=${result.candidateKid}`);
      return 0;
    }

    stderr(
      "Usage: signing-key <generate|prepare-rotation|validate|preflight> [options]",
    );
    return 2;
  } catch {
    stderr("Signing-key operation failed.");
    return 1;
  }
}

function parseOptions(
  args: readonly string[],
  allowed: readonly string[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      typeof flag !== "string" ||
      !flag.startsWith("--") ||
      typeof value !== "string" ||
      value.startsWith("--")
    ) {
      throw new Error("invalid_options");
    }
    const name = flag.slice(2);
    if (!allowed.includes(name) || result.has(name)) {
      throw new Error("invalid_options");
    }
    result.set(name, value);
  }
  if (args.length % 2 !== 0) throw new Error("invalid_options");
  return result;
}

function requireOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error("missing_option");
  return value;
}

function requireIgnoredOutput(
  directory: string,
  cwd: string,
  check: SigningKeyCliDependencies["isIgnored"],
): void {
  const ignored = (check ?? isGitIgnored)(
    resolve(directory, "jwt-signing-key-candidate-probe.json"),
    cwd,
  );
  if (!ignored) throw new Error("output_not_ignored");
}

function isGitIgnored(path: string, cwd: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", path], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function displayPath(path: string, cwd: string): string {
  const relativePath = relative(cwd, path);
  return relativePath.startsWith("..") ? path : relativePath;
}
