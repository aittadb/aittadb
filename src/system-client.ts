import type { ClientView } from "./types";

export const BROWSER_SESSION_CLIENT_ID = "aittadb-browser-session-v1";

export const BROWSER_SESSION_CLIENT: ClientView = Object.freeze({
  id: BROWSER_SESSION_CLIENT_ID,
  type: "public",
  name: "AittaDB current browser session",
  disabledAt: null,
  redirectUris: Object.freeze([]),
  scopes: Object.freeze([
    "openid",
    "email",
    "profile",
    "storage.read",
    "storage.write",
    "storage.delete",
    "events.publish",
    "events.read",
    "events.subscribe",
  ]),
  origins: Object.freeze([]),
  createdAt: 0,
});

export function isBrowserSessionClientId(clientId: string): boolean {
  return clientId === BROWSER_SESSION_CLIENT_ID;
}
