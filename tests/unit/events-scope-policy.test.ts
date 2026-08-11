import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  validateClientRegistrationInput,
  validateScopes,
} from "../../src/oauth";
import {
  availableOAuthScopes,
  availableServiceClientScopes,
  EVENT_SCOPES,
} from "../../src/oauth-scopes";
import {
  oidcConfiguration,
  oauthScopeMetadata,
  openApiSpec,
} from "../../src/openapi";
import { BROWSER_SESSION_CLIENT_ID } from "../../src/system-client";
import type { ClientRegistrationInput, ClientView } from "../../src/types";

const EVENT_SCOPE_LIST = ["events.publish", "events.read", "events.subscribe"];

test("Events scopes are recognized only when the deployment feature is enabled", () => {
  assert.deepEqual(EVENT_SCOPES, EVENT_SCOPE_LIST);
  assert.deepEqual(
    availableOAuthScopes(false).filter((scope) => scope.startsWith("events.")),
    [],
  );
  assert.deepEqual(
    availableOAuthScopes(true).filter((scope) => scope.startsWith("events.")),
    EVENT_SCOPE_LIST,
  );
  assert.deepEqual(availableServiceClientScopes(false), [
    "storage.read",
    "storage.write",
    "storage.delete",
  ]);
  assert.deepEqual(availableServiceClientScopes(true), [
    "storage.read",
    "storage.write",
    "storage.delete",
    ...EVENT_SCOPE_LIST,
  ]);

  const client = clientWithScopes(EVENT_SCOPE_LIST);
  for (const scope of EVENT_SCOPE_LIST) {
    assert.equal(validateScopes([scope], client, true), null);
    assert.equal(
      validateScopes([scope], client, false),
      `Unsupported scope: ${scope}`,
    );
  }
  assert.equal(validateScopes(["storage.read"], client, false), null);
  assert.equal(
    validateScopes(["unknown.scope"], client, true),
    "Unsupported scope: unknown.scope",
  );
});

test("public, confidential, and service registration apply one Events scope policy", () => {
  for (const type of ["public", "confidential", "service"] as const) {
    const input = registration(type, EVENT_SCOPE_LIST);
    assert.equal(validateClientRegistrationInput(input, true), null, type);
    assert.equal(
      validateClientRegistrationInput(input, false),
      "Unsupported scope: events.publish",
      type,
    );
  }

  assert.equal(
    validateClientRegistrationInput(registration("public", ["openid"]), false),
    null,
  );
  assert.equal(
    validateClientRegistrationInput(
      registration("confidential", ["openid", "offline_access"]),
      false,
    ),
    null,
  );
  assert.equal(
    validateClientRegistrationInput(
      registration("service", ["storage.read"]),
      false,
    ),
    null,
  );
  assert.match(
    validateClientRegistrationInput(
      registration("service", ["openid"]),
      true,
    ) ?? "",
    /only enabled AittaDB data scopes/,
  );
  assert.match(
    validateClientRegistrationInput(
      {
        ...registration("service", ["events.read"]),
        redirectUris: ["https://service.example.test/callback"],
      },
      true,
    ) ?? "",
    /cannot register redirect URIs/,
  );
  assert.match(
    validateClientRegistrationInput(
      {
        ...registration("service", ["events.read"]),
        origins: ["https://service.example.test"],
      },
      true,
    ) ?? "",
    /cannot register browser origins/,
  );
});

test("discovery and OpenAPI describe conditional AittaDB-only Events scopes without routes", () => {
  const disabled = oidcConfiguration("https://aittadb.example.test", {
    oauthAppsEnabled: true,
    eventsEnabled: false,
  });
  const enabled = oidcConfiguration("https://aittadb.example.test", {
    oauthAppsEnabled: true,
    eventsEnabled: true,
  });
  assert.deepEqual(
    disabled.scopes_supported?.filter((scope) => scope.startsWith("events.")),
    [],
  );
  assert.deepEqual(
    enabled.scopes_supported?.filter((scope) => scope.startsWith("events.")),
    EVENT_SCOPE_LIST,
  );
  assert.equal(
    "scopes_supported" in
      oidcConfiguration("https://aittadb.example.test", {
        oauthAppsEnabled: false,
        eventsEnabled: true,
      }),
    false,
  );

  for (const scope of EVENT_SCOPE_LIST) {
    const metadata =
      oauthScopeMetadata[scope as keyof typeof oauthScopeMetadata];
    assert.equal(metadata.feature, "FEATURE_EVENTS_ENABLED");
    assert.match(metadata.description, /AittaDB namespace/);
  }
  assert.equal("/events" in openApiSpec.paths, false);
  assert.equal("/events/{id}" in openApiSpec.paths, false);
});

test("migration seeds all Events scopes for the reserved browser client only once", async () => {
  const sqlite = await migratedDatabase();
  const migration = await readFile(
    new URL(
      "../../db/migrations/0014_browser_session_event_scopes.sql",
      import.meta.url,
    ),
    "utf8",
  );
  sqlite.exec(migration);

  const rows = sqlite
    .prepare(
      "SELECT scope FROM client_scopes WHERE client_id = ? AND scope LIKE 'events.%' ORDER BY scope",
    )
    .all(BROWSER_SESSION_CLIENT_ID) as Array<{ scope: string }>;
  assert.deepEqual(
    rows.map((row) => row.scope),
    [...EVENT_SCOPE_LIST].sort(),
  );
});

function registration(
  type: ClientRegistrationInput["type"],
  scopes: readonly string[],
): ClientRegistrationInput {
  return {
    type,
    name: `${type} Events client`,
    redirectUris:
      type === "service" ? [] : [`https://${type}.example.test/callback`],
    scopes,
    origins: type === "service" ? [] : [`https://${type}.example.test`],
  };
}

function clientWithScopes(scopes: readonly string[]): ClientView {
  return {
    id: "client",
    type: "public",
    name: "Scope client",
    disabledAt: null,
    redirectUris: [],
    scopes: ["storage.read", ...scopes],
    origins: [],
    createdAt: 1,
  };
}

async function migratedDatabase(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrationUrl = new URL("../../db/migrations/", import.meta.url);
  const migrationNames = (await readdir(migrationUrl))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrationNames) {
    sqlite.exec(await readFile(new URL(name, migrationUrl), "utf8"));
  }
  return sqlite;
}
