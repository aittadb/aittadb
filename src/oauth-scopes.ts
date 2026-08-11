import { SUPPORTED_SCOPES, type OAuthScope } from "./types";

export const EVENT_SCOPES = [
  "events.publish",
  "events.read",
  "events.subscribe",
] as const satisfies readonly OAuthScope[];

export const STORAGE_SCOPES = [
  "storage.read",
  "storage.write",
  "storage.delete",
] as const satisfies readonly OAuthScope[];

const BASE_SCOPES = SUPPORTED_SCOPES.filter(
  (scope) => !EVENT_SCOPES.includes(scope as (typeof EVENT_SCOPES)[number]),
);

export const SERVICE_CLIENT_SCOPES = [
  ...STORAGE_SCOPES,
  ...EVENT_SCOPES,
] as const satisfies readonly OAuthScope[];

export function availableOAuthScopes(
  eventsEnabled: boolean,
): readonly OAuthScope[] {
  return eventsEnabled ? SUPPORTED_SCOPES : BASE_SCOPES;
}

export function availableServiceClientScopes(
  eventsEnabled: boolean,
): readonly OAuthScope[] {
  return eventsEnabled ? SERVICE_CLIENT_SCOPES : STORAGE_SCOPES;
}

export function validateAvailableScopes(
  scopes: readonly string[],
  eventsEnabled: boolean,
): string | null {
  const available = availableOAuthScopes(eventsEnabled);
  for (const scope of scopes) {
    if (!available.includes(scope as OAuthScope)) {
      return `Unsupported scope: ${scope}`;
    }
  }
  return null;
}
