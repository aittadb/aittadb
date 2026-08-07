import { nowSeconds } from "./crypto";
import { readSitesIdentity, requireSitesIdentity } from "./identity";
import { oauthError } from "./http";
import { issueTokens } from "./oauth";
import { BROWSER_SESSION_CLIENT_ID } from "./system-client";
import type { AppConfig, AuthStore, RuntimeEnv } from "./types";

export type BrowserSessionScope =
  | "email"
  | "profile"
  | "storage.read"
  | "storage.write"
  | "storage.delete";

export function hasBrowserSession(request: Request, env: RuntimeEnv): boolean {
  return readSitesIdentity(request, env) !== null;
}

export async function issueBrowserSessionAccessToken(
  request: Request,
  env: RuntimeEnv,
  store: AuthStore,
  config: AppConfig,
  scopes: readonly BrowserSessionScope[],
): Promise<string | Response> {
  const identity = readSitesIdentity(request, env);
  if (!identity) return requireSitesIdentity(request, env) as Response;

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
  const tokens = await issueTokens({
    config,
    store,
    user,
    client,
    scope: scopes.join(" "),
    includeRefresh: false,
    now,
  });
  const accessToken = tokens.access_token;
  return typeof accessToken === "string"
    ? accessToken
    : oauthError(
        "service_unavailable",
        "Current-session operations are unavailable",
        503,
      );
}
