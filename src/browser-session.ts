import { nowSeconds } from "./crypto";
import {
  requireSitesIdentity,
  type UpstreamIdentityProvider,
} from "./identity";
import { oauthError } from "./http";
import { issueTokens } from "./oauth";
import { BROWSER_SESSION_CLIENT_ID } from "./system-client";
import { isSubjectAuthorizationDenied } from "./subject-access";
import type { AppConfig, AuthStore } from "./types";

export type BrowserSessionScope =
  | "openid"
  | "email"
  | "profile"
  | "storage.read"
  | "storage.write"
  | "storage.delete";

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
