import { existsSync, readFileSync } from "node:fs";

export interface SitesHostingConfig {
  project_id?: string;
  d1?: string;
  r2?: string;
}

export function loadSitesHostingConfig(
  localPath: URL,
  templatePath: URL,
): SitesHostingConfig {
  const sourcePath = existsSync(localPath) ? localPath : templatePath;
  const parsed: unknown = JSON.parse(readFileSync(sourcePath, "utf8"));
  if (!isRecord(parsed)) throw new Error("Invalid Sites hosting configuration");

  return {
    project_id: optionalString(parsed, "project_id"),
    d1: optionalString(parsed, "d1"),
    r2: optionalString(parsed, "r2"),
  };
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`Invalid Sites hosting configuration field: ${key}`);
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
