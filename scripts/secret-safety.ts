export type SecretFindingCategory =
  | "bearer-credential"
  | "forbidden-secret-path"
  | "private-jwk"
  | "private-key"
  | "provider-credential";

export interface SecretFinding {
  category: SecretFindingCategory;
  path: string;
  commit?: string;
}

export interface TrackedFile {
  path: string;
  contents?: string;
}

export interface SecretScanOptions {
  allowLegacyHostingPath?: boolean;
}

const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/;
const PRIVATE_JWK_VALUE_PATTERN = /"d"\s*:\s*"[A-Za-z0-9_-]{20,}"/g;
const JWK_CONTEXT_PATTERN = /(?:"kty"\s*:\s*"(?:EC|RSA|OKP)"|JWT_PRIVATE_JWK)/;
const PROVIDER_CREDENTIAL_PATTERNS = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{70,255}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/,
  /\bsk-proj-[0-9A-Za-z_-]{20,}\b/,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
];
const COMPACT_JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;
const BEARER_HEADER_PATTERN = /\bBearer\s+([A-Za-z0-9._~+/-]{16,}={0,2})\b/g;
const SENSITIVE_NAME = String.raw`(?:access[_-]?token|api[_-]?key|api[_-]?token|auth[_-]?token|authorization[_-]?code|client[_-]?secret|cookie[_-]?secret|device[_-]?code|jwt[_-]?private[_-]?jwk|password|private[_-]?key|refresh[_-]?token|secret[_-]?access[_-]?key|session[_-]?token|signing[_-]?secret|(?:cf|cloudflare|github|npm|openai)[_-]?(?:api[_-]?)?(?:key|token))`;
const QUOTED_SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`["']?${SENSITIVE_NAME}["']?\s*(?:=|:)\s*(["'\x60])([^\r\n]*?)\1`,
  "gi",
);
const ENV_SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`^\s*(?:export\s+)?${SENSITIVE_NAME}\s*=\s*([^\s#]+)`,
  "gim",
);

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isSafeTemplatePath(path: string): boolean {
  return (
    /(^|\/)(?:\.env|\.dev\.vars)\.(?:example|sample|template)$/.test(path) ||
    path === ".openai/hosting.example.json"
  );
}

function isSyntheticFixture(path: string, contents: string | undefined) {
  return (
    path.startsWith("tests/fixtures/") &&
    contents?.includes("AITTADB_SYNTHETIC_TEST_FIXTURE") === true
  );
}

function hasForbiddenSecretPath(path: string): boolean {
  if (isSafeTemplatePath(path)) return false;

  const basename = path.slice(path.lastIndexOf("/") + 1);
  return (
    /(^|\/)(?:\.env(?:\..+)?|\.dev\.vars(?:\..+)?|\.envrc)$/.test(path) ||
    /(^|\/)(?:\.secrets|\.wrangler)(?:\/|$)/.test(path) ||
    path === ".openai/hosting.json" ||
    /(^|\/)(?:\.netrc|\.npmrc|\.pypirc)$/.test(path) ||
    /(?:^|\.)(?:p12|pfx|jks|keystore|key|tfstate|tfvars)$/.test(basename) ||
    /^id_(?:dsa|ecdsa|ed25519|rsa)$/.test(basename) ||
    /^(?:credentials|service[-_]account|client[-_]secrets?|admin[-_]secrets?|secrets?)\.(?:json|toml|ya?ml)$/.test(
      basename,
    )
  );
}

export function isLegacyPublicDeploymentMetadata(path: string): boolean {
  return normalizedPath(path) === ".openai/hosting.json";
}

function isPlaceholder(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length === 0) return true;
  if (
    normalized.startsWith("$") ||
    normalized.startsWith("<") ||
    normalized.startsWith("{{") ||
    normalized.startsWith("%")
  ) {
    return true;
  }

  return (
    /^(?:changeme|dummy|example|fake|not[-_]?a[-_]?real|placeholder|redacted|replace[-_]?me|sample|synthetic|test)(?:[-_][a-z0-9]+)*$/i.test(
      normalized,
    ) ||
    /^(?:[a-z]+[-_])*(?:code|key|secret|token)(?:[-_][a-z]+)*$/i.test(
      normalized,
    ) ||
    /^(?:x+|\*+|\.+)$/i.test(normalized)
  );
}

function hasPrivateJwk(contents: string): boolean {
  const normalized = contents.replaceAll('\\"', '"');
  for (const match of normalized.matchAll(PRIVATE_JWK_VALUE_PATTERN)) {
    const offset = match.index ?? 0;
    const context = normalized.slice(
      Math.max(0, offset - 1_000),
      Math.min(normalized.length, offset + 1_000),
    );
    if (JWK_CONTEXT_PATTERN.test(context)) return true;
  }
  return false;
}

function hasProviderCredential(contents: string): boolean {
  return PROVIDER_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(contents));
}

function hasBearerCredential(
  contents: string,
  includeGenericAssignments: boolean,
): boolean {
  if (COMPACT_JWT_PATTERN.test(contents)) return true;

  for (const match of contents.matchAll(BEARER_HEADER_PATTERN)) {
    if (!isPlaceholder(match[1] ?? "")) return true;
  }

  if (!includeGenericAssignments) return false;

  for (const match of contents.matchAll(QUOTED_SENSITIVE_ASSIGNMENT_PATTERN)) {
    const value = match[2] ?? "";
    if (value.length >= 16 && !isPlaceholder(value)) return true;
  }

  for (const match of contents.matchAll(ENV_SENSITIVE_ASSIGNMENT_PATTERN)) {
    const value = match[1] ?? "";
    if (value.length >= 16 && !isPlaceholder(value)) return true;
  }
  return false;
}

export function scanTrackedFile(
  file: TrackedFile,
  options: SecretScanOptions = {},
): SecretFinding[] {
  const path = normalizedPath(file.path);
  if (isSyntheticFixture(path, file.contents)) return [];

  const categories = new Set<SecretFindingCategory>();
  if (
    hasForbiddenSecretPath(path) &&
    !(options.allowLegacyHostingPath && isLegacyPublicDeploymentMetadata(path))
  ) {
    categories.add("forbidden-secret-path");
  }

  const contents = file.contents;
  if (contents !== undefined) {
    if (PRIVATE_KEY_PATTERN.test(contents)) categories.add("private-key");
    if (hasPrivateJwk(contents)) categories.add("private-jwk");
    if (hasProviderCredential(contents)) {
      categories.add("provider-credential");
    }
    if (
      !path.startsWith("tests/") &&
      hasBearerCredential(contents, !path.startsWith("public/vendor/"))
    ) {
      categories.add("bearer-credential");
    }
  }

  return [...categories].sort().map((category) => ({ category, path }));
}

export function scanTrackedFiles(
  files: Iterable<TrackedFile>,
): SecretFinding[] {
  return [...files]
    .flatMap((file) => scanTrackedFile(file))
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.category.localeCompare(right.category),
    );
}

export function formatSecretFinding(finding: SecretFinding): string {
  return [finding.category, finding.path, finding.commit]
    .filter((part): part is string => part !== undefined)
    .join("\t");
}
