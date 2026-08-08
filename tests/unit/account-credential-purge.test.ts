import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { ACCOUNT_CREDENTIAL_PURGE_MAX_BATCH } from "../../src/store/account-credential-purge";
import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import { BROWSER_SESSION_CLIENT_ID } from "../../src/system-client";
import type { AuthStore, ClientView, StorageLimits } from "../../src/types";

const LARGE_FIXTURE_COUNT = 18;
const PURGE_LIMIT = 13;
const STORAGE_LIMITS: StorageLimits = {
  writesEnabled: true,
  globalMaxItems: 100,
  globalMaxBytes: 100_000,
  userMaxItems: 100,
  userMaxBytes: 100_000,
  namespaceMaxItems: 100,
  namespaceMaxBytes: 100_000,
};

test("revoked access-token migration adds nullable subject ownership", async () => {
  const sqlite = await migratedDatabase();
  try {
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((table) => String(table.name));
    assert.ok(!tables.includes("browser_sessions"));
    const userColumn = sqlite
      .prepare("PRAGMA table_info(revoked_access_tokens)")
      .all()
      .find((column) => String(column.name) === "user_id");
    assert.ok(userColumn);
    assert.equal(Number(userColumn.notnull), 0);
    const indexes = sqlite
      .prepare("PRAGMA index_list(revoked_access_tokens)")
      .all()
      .map((index) => String(index.name));
    assert.ok(indexes.includes("idx_revoked_access_tokens_user_revoked_jti"));
    for (const [table, index] of [
      ["authorization_codes", "idx_authorization_codes_user_expires_code"],
      ["authorization_requests", "idx_authorization_requests_user_expires_id"],
      ["device_grants", "idx_device_grants_user_expires_id"],
      ["consents", "idx_consents_user_created_client_scope"],
      ["refresh_tokens", "idx_refresh_tokens_user_expires_id"],
      ["refresh_token_families", "idx_refresh_families_user_created_id"],
    ]) {
      assert.ok(
        sqlite
          .prepare(`PRAGMA index_list(${table})`)
          .all()
          .some((candidate) => String(candidate.name) === index),
      );
    }

    const store = new D1AuthStore(sqliteD1(sqlite));
    const subject = await createSubject(store, "migration-target", 1);
    sqlite
      .prepare(
        "INSERT INTO revoked_access_tokens (jti, expires_at, revoked_at) VALUES (?, ?, ?)",
      )
      .run("legacy-unattributed", 500, 5);
    await store.revokeAccessTokenJti("owned-revocation", subject, 500, 6);
    await store.startAccountDeletionJob(subject, 10);

    assert.deepEqual(
      await store.purgeAccountCredentialsAndGrants(subject, 10),
      {
        deletedCount: 1,
        done: true,
      },
    );
    assert.equal(
      Number(
        sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM revoked_access_tokens WHERE jti = ? AND user_id IS NULL",
          )
          .get("legacy-unattributed")?.count,
      ),
      1,
    );
  } finally {
    sqlite.close();
  }
});

test("D1 and memory purge finite deterministic batches with subject isolation", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const clients = await createClients(fixture.store, adapter.name);
        const subject = await createSubject(
          fixture.store,
          `${adapter.name}-target`,
          10,
        );
        const otherSubject = await createSubject(
          fixture.store,
          `${adapter.name}-control`,
          11,
        );
        await seedCredentialSets(
          fixture.store,
          subject,
          clients,
          "target",
          LARGE_FIXTURE_COUNT,
        );
        await seedCredentialSets(
          fixture.store,
          otherSubject,
          clients,
          "control",
          2,
        );
        await seedAnonymousGrantState(fixture.store, clients[0]!);
        await seedStorage(fixture.store, subject, clients[0]!, "target");
        await seedStorage(fixture.store, otherSubject, clients[0]!, "control");
        await fixture.store.startAccountDeletionJob(subject, 20);

        const before = await fixture.snapshot(subject);
        assert.deepEqual(
          credentialCounts(before),
          filledCounts(LARGE_FIXTURE_COUNT),
        );
        const expectedDeleted = credentialTotal(before);

        const first = await fixture.store.purgeAccountCredentialsAndGrants(
          subject,
          PURGE_LIMIT,
        );
        assert.deepEqual(first, { deletedCount: PURGE_LIMIT, done: false });
        const afterFirst = await fixture.snapshot(subject);
        assert.equal(
          afterFirst.authorizationCodes,
          LARGE_FIXTURE_COUNT - PURGE_LIMIT,
        );
        assert.equal(afterFirst.authorizationRequests, LARGE_FIXTURE_COUNT);
        assert.equal(afterFirst.deviceGrants, LARGE_FIXTURE_COUNT);

        let deletedCount = first.deletedCount;
        let done = first.done;
        let calls = 1;
        while (!done) {
          const result = await fixture.store.purgeAccountCredentialsAndGrants(
            subject,
            PURGE_LIMIT,
          );
          assert.ok(result.deletedCount > 0);
          assert.ok(result.deletedCount <= PURGE_LIMIT);
          deletedCount += result.deletedCount;
          done = result.done;
          calls += 1;
          assert.ok(calls < 20);
        }
        assert.equal(deletedCount, expectedDeleted);
        assert.ok(calls > 1);
        assert.deepEqual(
          credentialCounts(await fixture.snapshot(subject)),
          filledCounts(0),
        );
        assert.deepEqual(
          await fixture.store.purgeAccountCredentialsAndGrants(
            subject,
            ACCOUNT_CREDENTIAL_PURGE_MAX_BATCH,
          ),
          { deletedCount: 0, done: true },
        );

        assert.deepEqual(
          credentialCounts(await fixture.snapshot(otherSubject)),
          filledCounts(2),
        );
        assert.equal(
          (await fixture.store.getAuthorizationRequest("anonymous-request"))
            ?.userId,
          null,
        );
        assert.equal(
          (await fixture.store.getDeviceGrantByDeviceHash("anonymous-device"))
            ?.userId,
          null,
        );
        assert.ok(await fixture.store.getClient(clients[0]!.id));
        assert.ok(await fixture.store.getClient(clients[1]!.id));
        assert.ok(await fixture.store.getClient(BROWSER_SESSION_CLIENT_ID));
        assert.ok(await fixture.store.getUser(subject));
        assert.ok(await fixture.store.getAccountDeletionJob(subject));
        assert.equal((await fixture.snapshot(subject)).storageRecords, 1);
        assert.equal((await fixture.snapshot(subject)).storageFiles, 1);
        assert.equal((await fixture.snapshot(otherSubject)).storageRecords, 1);
        assert.equal((await fixture.snapshot(otherSubject)).storageFiles, 1);
      } finally {
        fixture.close();
      }
    });
  }
});

test("purge refuses active subjects and invalid bounds before mutation", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const clients = await createClients(
          fixture.store,
          `${adapter.name}-guard`,
        );
        const subject = await createSubject(
          fixture.store,
          `${adapter.name}-active`,
          30,
        );
        await seedCredentialSets(fixture.store, subject, clients, "guard", 1);
        const before = await fixture.snapshot(subject);
        await assert.rejects(
          fixture.store.purgeAccountCredentialsAndGrants(subject, 1),
          /account_credential_purge_unavailable/,
        );
        assert.deepEqual(await fixture.snapshot(subject), before);

        await fixture.store.startAccountDeletionJob(subject, 40);
        await assert.rejects(
          fixture.store.purgeAccountCredentialsAndGrants(subject, 0),
          /account_credential_purge_limit_invalid/,
        );
        await assert.rejects(
          fixture.store.purgeAccountCredentialsAndGrants(
            subject,
            ACCOUNT_CREDENTIAL_PURGE_MAX_BATCH + 1,
          ),
          /account_credential_purge_limit_invalid/,
        );
        assert.deepEqual(await fixture.snapshot(subject), before);
      } finally {
        fixture.close();
      }
    });
  }
});

test("D1 retries safely after an interrupted child-before-parent purge", async () => {
  const sqlite = await migratedDatabase();
  try {
    const base = sqliteD1(sqlite);
    const store = new D1AuthStore(
      failRunOnce(base, "DELETE FROM device_grants", "purge_interrupted"),
    );
    const inspectionStore = new D1AuthStore(base);
    const clients = await createClients(store, "interruption");
    const subject = await createSubject(store, "interrupted-target", 50);
    const otherSubject = await createSubject(store, "interrupted-control", 51);
    await seedCredentialSets(store, subject, clients, "interrupted-target", 1);
    await seedCredentialSets(
      store,
      otherSubject,
      clients,
      "interrupted-control",
      1,
    );
    await store.startAccountDeletionJob(subject, 60);

    await assert.rejects(
      store.purgeAccountCredentialsAndGrants(subject, 100),
      /purge_interrupted/,
    );
    const interrupted = sqliteSnapshot(sqlite, subject);
    assert.equal(interrupted.authorizationCodes, 0);
    assert.equal(interrupted.authorizationRequests, 0);
    assert.equal(interrupted.deviceGrants, 1);

    assert.deepEqual(
      await inspectionStore.purgeAccountCredentialsAndGrants(subject, 100),
      { deletedCount: 6, done: true },
    );
    assert.deepEqual(
      credentialCounts(sqliteSnapshot(sqlite, subject)),
      filledCounts(0),
    );
    assert.deepEqual(
      credentialCounts(sqliteSnapshot(sqlite, otherSubject)),
      filledCounts(1),
    );
  } finally {
    sqlite.close();
  }
});

interface CredentialSnapshot {
  authorizationCodes: number;
  authorizationRequests: number;
  deviceGrants: number;
  consents: number;
  refreshTokens: number;
  refreshFamilies: number;
  revokedJtis: number;
  adminSubmissions: number;
  storageRecords: number;
  storageFiles: number;
}

interface StoreFixture {
  store: AuthStore;
  snapshot(subject: string): Promise<CredentialSnapshot>;
  close(): void;
}

function adapters(): Array<{
  name: string;
  create(): Promise<StoreFixture>;
}> {
  return [
    {
      name: "memory",
      create: async () => {
        const store = new MemoryAuthStore();
        return {
          store,
          snapshot: async (subject) => memorySnapshot(store, subject),
          close: () => undefined,
        };
      },
    },
    {
      name: "d1",
      create: async () => {
        const sqlite = await migratedDatabase();
        return {
          store: new D1AuthStore(sqliteD1(sqlite)),
          snapshot: async (subject) => sqliteSnapshot(sqlite, subject),
          close: () => sqlite.close(),
        };
      },
    },
  ];
}

async function createClients(
  store: AuthStore,
  prefix: string,
): Promise<ClientView[]> {
  return Promise.all(
    [0, 1].map((index) =>
      store.createClient(
        {
          type: "public",
          name: `${prefix} client ${index}`,
          redirectUris: [`https://${prefix}-${index}.example.test/callback`],
          scopes: ["openid", "offline_access", "storage.read"],
          origins: [`https://${prefix}-${index}.example.test`],
        },
        null,
        index + 1,
      ),
    ),
  );
}

async function createSubject(
  store: AuthStore,
  prefix: string,
  now: number,
): Promise<string> {
  return (
    await store.findOrCreateUser(
      {
        email: `${prefix}@example.test`,
        fullName: null,
        displayName: "Synthetic user",
      },
      now,
    )
  ).id;
}

async function seedCredentialSets(
  store: AuthStore,
  subject: string,
  clients: ClientView[],
  prefix: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const client = clients[index % clients.length]!;
    const suffix = String(index).padStart(3, "0");
    const requestId = `${prefix}-request-${suffix}`;
    const familyId = `${prefix}-family-${suffix}`;
    await store.createAuthorizationRequest({
      id: requestId,
      clientId: client.id,
      redirectUri: client.redirectUris[0]!,
      scope: "openid offline_access",
      state: null,
      nonce: null,
      codeChallenge: "a".repeat(43),
      createdAt: index + 100,
      expiresAt: index + 1_000,
      userId: subject,
      status: "approved",
    });
    await store.createAuthorizationCode({
      codeHash: `${prefix}-code-${suffix}`,
      authRequestId: requestId,
      clientId: client.id,
      redirectUri: client.redirectUris[0]!,
      userId: subject,
      scope: "openid offline_access",
      nonce: null,
      expiresAt: index + 1_100,
      consumedAt: null,
    });
    await store.createDeviceGrant({
      id: `${prefix}-device-id-${suffix}`,
      deviceCodeHash: `${prefix}-device-${suffix}`,
      userCodeHash: `${prefix}-user-code-${suffix}`,
      userCodeDisplay: "",
      clientId: client.id,
      scope: "openid offline_access",
      status: "approved",
      userId: subject,
      createdAt: index + 100,
      expiresAt: index + 1_200,
      intervalSeconds: 5,
      lastPollAt: null,
      slowDownCount: 0,
    });
    await store.saveConsent(
      subject,
      client.id,
      `${prefix}-scope-${suffix}`,
      index + 100,
    );
    await store.createRefreshFamily({
      id: familyId,
      userId: subject,
      clientId: client.id,
      status: "active",
      createdAt: index + 100,
    });
    await store.createRefreshToken({
      id: `${prefix}-refresh-id-${suffix}`,
      familyId,
      tokenHash: `${prefix}-refresh-${suffix}`,
      userId: subject,
      clientId: client.id,
      scope: "openid offline_access",
      expiresAt: index + 1_300,
      usedAt: null,
      revokedAt: null,
    });
    await store.revokeAccessTokenJti(
      `${prefix}-jti-${suffix}`,
      subject,
      index + 1_400,
      index + 100,
    );
    assert.equal(
      await store.claimAdminOperationSubmission(
        `${prefix}-admin-${suffix}`,
        subject,
        index + 100,
        index + 1_500,
      ),
      true,
    );
  }
}

async function seedAnonymousGrantState(
  store: AuthStore,
  client: ClientView,
): Promise<void> {
  await store.createAuthorizationRequest({
    id: "anonymous-request",
    clientId: client.id,
    redirectUri: client.redirectUris[0]!,
    scope: "openid",
    state: null,
    nonce: null,
    codeChallenge: "b".repeat(43),
    createdAt: 1,
    expiresAt: 2_000,
    userId: null,
    status: "pending",
  });
  await store.createDeviceGrant({
    id: "anonymous-device-id",
    deviceCodeHash: "anonymous-device",
    userCodeHash: "anonymous-user-code",
    userCodeDisplay: "",
    clientId: client.id,
    scope: "openid",
    status: "pending",
    userId: null,
    createdAt: 1,
    expiresAt: 2_000,
    intervalSeconds: 5,
    lastPollAt: null,
    slowDownCount: 0,
  });
}

async function seedStorage(
  store: AuthStore,
  subject: string,
  client: ClientView,
  prefix: string,
): Promise<void> {
  assert.equal(
    await store.upsertStorageRecord(
      {
        userId: subject,
        clientId: client.id,
        key: `${prefix}-record`,
        valueJson: "{}",
        createdAt: 1,
        updatedAt: 1,
      },
      STORAGE_LIMITS,
    ),
    true,
  );
  assert.equal(
    await store.upsertStorageFileMetadata(
      {
        userId: subject,
        clientId: client.id,
        key: `${prefix}-file`,
        r2Key: `${prefix}-physical-object`,
        contentType: "application/octet-stream",
        size: 1,
        sha256: "synthetic-digest",
        createdAt: 1,
        updatedAt: 1,
      },
      null,
      STORAGE_LIMITS,
    ),
    true,
  );
}

function credentialCounts(snapshot: CredentialSnapshot): number[] {
  return [
    snapshot.authorizationCodes,
    snapshot.authorizationRequests,
    snapshot.deviceGrants,
    snapshot.consents,
    snapshot.refreshTokens,
    snapshot.refreshFamilies,
    snapshot.revokedJtis,
    snapshot.adminSubmissions,
  ];
}

function filledCounts(value: number): number[] {
  return Array.from({ length: 8 }, () => value);
}

function credentialTotal(snapshot: CredentialSnapshot): number {
  return credentialCounts(snapshot).reduce((total, count) => total + count, 0);
}

function memorySnapshot(
  store: MemoryAuthStore,
  subject: string,
): CredentialSnapshot {
  return {
    authorizationCodes: countValues(
      store.authCodes,
      (value) => value.userId === subject,
    ),
    authorizationRequests: countValues(
      store.authRequests,
      (value) => value.userId === subject,
    ),
    deviceGrants: countValues(
      store.devices,
      (value) => value.userId === subject,
    ),
    consents: Array.from(store.consents.keys()).filter((key) =>
      key.startsWith(`${subject}:`),
    ).length,
    refreshTokens: countValues(
      store.refreshTokens,
      (value) => value.userId === subject,
    ),
    refreshFamilies: countValues(
      store.families,
      (value) => value.userId === subject,
    ),
    revokedJtis: countValues(
      store.revokedJtis,
      (value) => value.subject === subject,
    ),
    adminSubmissions: countValues(
      store.adminOperationSubmissions,
      (value) => value.userId === subject,
    ),
    storageRecords: countValues(
      store.storageRecords,
      (value) => value.userId === subject,
    ),
    storageFiles: countValues(
      store.storageFiles,
      (value) => value.userId === subject,
    ),
  };
}

function countValues<T>(
  values: Map<string, T>,
  predicate: (value: T) => boolean,
): number {
  return Array.from(values.values()).filter(predicate).length;
}

function sqliteSnapshot(
  sqlite: DatabaseSync,
  subject: string,
): CredentialSnapshot {
  return {
    authorizationCodes: sqliteCount(sqlite, "authorization_codes", subject),
    authorizationRequests: sqliteCount(
      sqlite,
      "authorization_requests",
      subject,
    ),
    deviceGrants: sqliteCount(sqlite, "device_grants", subject),
    consents: sqliteCount(sqlite, "consents", subject),
    refreshTokens: sqliteCount(sqlite, "refresh_tokens", subject),
    refreshFamilies: sqliteCount(sqlite, "refresh_token_families", subject),
    revokedJtis: sqliteCount(sqlite, "revoked_access_tokens", subject),
    adminSubmissions: sqliteCount(
      sqlite,
      "admin_operation_submissions",
      subject,
    ),
    storageRecords: sqliteCount(sqlite, "storage_records", subject),
    storageFiles: sqliteCount(sqlite, "storage_files", subject),
  };
}

function sqliteCount(
  sqlite: DatabaseSync,
  table: string,
  subject: string,
): number {
  return Number(
    sqlite
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`)
      .get(subject)?.count ?? 0,
  );
}

async function migratedDatabase(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  const migrationUrl = new URL("../../db/migrations/", import.meta.url);
  const migrationNames = (await readdir(migrationUrl))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrationNames) {
    sqlite.exec(await readFile(new URL(name, migrationUrl), "utf8"));
  }
  return sqlite;
}

function sqliteD1(database: DatabaseSync): D1Database {
  return {
    prepare(query: string): D1PreparedStatement {
      let values: SQLInputValue[] = [];
      const statement: D1PreparedStatement = {
        bind(...nextValues: unknown[]): D1PreparedStatement {
          values = nextValues as SQLInputValue[];
          return statement;
        },
        async first<T>(): Promise<T | null> {
          return (
            (database.prepare(query).get(...values) as T | undefined) ?? null
          );
        },
        async all<T>(): Promise<D1Result<T>> {
          return {
            success: true,
            results: database.prepare(query).all(...values) as T[],
          };
        },
        async run<T>(): Promise<D1Result<T>> {
          const result = database.prepare(query).run(...values);
          return {
            success: true,
            meta: { changes: Number(result.changes) },
          };
        },
      };
      return statement;
    },
  };
}

function failRunOnce(
  database: D1Database,
  queryFragment: string,
  errorMessage: string,
): D1Database {
  let failed = false;
  return {
    prepare(query: string): D1PreparedStatement {
      const inner = database.prepare(query);
      let bound = inner;
      const statement: D1PreparedStatement = {
        bind(...values: unknown[]): D1PreparedStatement {
          bound = inner.bind(...values);
          return statement;
        },
        first: <T>() => bound.first<T>(),
        all: <T>() => bound.all<T>(),
        async run<T>(): Promise<D1Result<T>> {
          if (!failed && query.includes(queryFragment)) {
            failed = true;
            throw new Error(errorMessage);
          }
          return bound.run<T>();
        },
      };
      return statement;
    },
  };
}
