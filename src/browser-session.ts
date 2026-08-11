import { nowSeconds } from "./crypto";
import {
  requireSitesIdentity,
  type UpstreamIdentityProvider,
} from "./identity";
import { oauthError } from "./http";
import { issueTokens, validateScopes } from "./oauth";
import { validateAvailableScopes } from "./oauth-scopes";
import { BROWSER_SESSION_CLIENT_ID } from "./system-client";
import { isSubjectAuthorizationDenied } from "./subject-access";
import type { AppConfig, AuthStore } from "./types";

export type BrowserSessionScope =
  | "openid"
  | "email"
  | "profile"
  | "storage.read"
  | "storage.write"
  | "storage.delete"
  | "events.publish"
  | "events.read"
  | "events.subscribe";

export function hasBrowserSession(
  request: Request,
  identityProvider: UpstreamIdentityProvider,
): boolean {
  return identityProvider.read(request) !== null;
}

export async function issueBrowserSessionAccessToken(
  request: Request,
  identityProvider: UpstreamIdentityProvider,
  store: AuthStore,
  config: AppConfig,
  scopes: readonly BrowserSessionScope[],
): Promise<string | Response> {
  const availabilityError = validateAvailableScopes(
    scopes,
    config.features.events,
  );
  if (availabilityError)
    return oauthError("invalid_scope", availabilityError, 400);

  const identity = identityProvider.read(request);
  if (!identity)
    return requireSitesIdentity(request, identityProvider) as Response;

  const client = await store.getClient(BROWSER_SESSION_CLIENT_ID);
  if (!client || client.disabledAt) {
    return oauthError(
      "service_unavailable",
      "Current-session operations are unavailable",
      503,
    );
  }
  const scopeError = validateScopes(scopes, client, config.features.events);
  if (scopeError) return oauthError("invalid_scope", scopeError, 400);

  const now = nowSeconds();
  const user = await store.findOrCreateUser(identity, now);
  let tokens: Record<string, unknown>;
  try {
    tokens = await issueTokens({
      config,
      store,
      user,
      client,
      scope: scopes.join(" "),
      includeRefresh: false,
      now,
    });
  } catch (error) {
    if (isSubjectAuthorizationDenied(error)) {
      return oauthError("login_required", "Browser session unavailable", 401);
    }
    throw error;
  }
  const accessToken = tokens.access_token;
  return typeof accessToken === "string"
    ? accessToken
    : oauthError(
        "service_unavailable",
        "Current-session operations are unavailable",
        503,
      );
}
