import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { nowSeconds } from "../../src/crypto";
import {
  createClientRegistration,
  issueTokens,
  verifyAccessToken,
} from "../../src/oauth";
import { SubjectAuthorizationDenied } from "../../src/subject-access";
import { MemoryAuthStore } from "../../src/store/memory";
import type {
  RefreshTokenRecord,
  StorageListPage,
  StorageListPosition,
  StorageRecord,
  UpstreamIdentity,
} from "../../src/types";
import { createTestAittaDB, form, testEnv } from "../helpers";

const identity: UpstreamIdentity = {
  email: "deletion-gate@example.test",
  fullName: "Deletion Gate User",
  displayName: "Deletion Gate User",
};

class GateTrackingStore extends MemoryAuthStore {
  refreshSuccessorWrites = 0;
  storageListReads = 0;
  storageMutations = 0;
  storageRateChecks = 0;

  override async createRefreshToken(token: RefreshTokenRecord): Promise<void> {
    this.refreshSuccessorWrites += 1;
    return super.createRefreshToken(token);
  }

  override async listStorageRecords(
    userId: string,
    clientId: string,
    after: StorageListPosition | null,
    limit: number,
  ): Promise<StorageListPage<StorageRecord>> {
    this.storageListReads += 1;
    return super.listStorageRecords(userId, clientId, after, limit);
  }

  override async upsertStorageRecord(
    ...args: Parameters<MemoryAuthStore["upsertStorageRecord"]>
  ): Promise<boolean> {
    this.storageMutations += 1;
    return super.upsertStorageRecord(...args);
  }

  override async rateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
    now: number,
  ): Promise<boolean> {
    if (key.startsWith("storage:read:") || key.startsWith("storage:write:")) {
      this.storageRateChecks += 1;
    }
    return super.rateLimit(key, limit, windowSeconds, now);
  }
}

test("deletion start rejects existing sessions, credentials, and storage before access", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" });
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new GateTrackingStore();
  const user = await store.findOrCreateUser(identity, nowSeconds());
  const registration = await createClientRegistration(
    {
      type: "confidential",
      name: "Deletion Gate Client",
      redirectUris: ["https://client.example.test/callback"],
      scopes: [
        "openid",
        "email",
        "offline_access",
        "storage.read",
        "storage.write",
      ],
      origins: [],
    },
    store,
    nowSeconds(),
  );
  const tokens = await issueTokens({
    config,
    store,
    user,
    client: registration.client,
    scope: "openid email offline_access storage.read storage.write",
    includeRefresh: true,
    now: nowSeconds(),
  });
  const accessToken = String(tokens.access_token);
  const refreshToken = String(tokens.refresh_token);
  const app = createTestAittaDB(env, store, identity);

  await store.startAccountDeletionJob(user.id, nowSeconds());
  store.refreshSuccessorWrites = 0;
  store.storageListReads = 0;
  store.storageMutations = 0;
  store.storageRateChecks = 0;

  await assert.rejects(
    issueTokens({
      config,
      store,
      user,
      client: registration.client,
      scope: "openid storage.read",
      includeRefresh: false,
      now: nowSeconds(),
    }),
    SubjectAuthorizationDenied,
  );
  await assert.rejects(
    verifyAccessToken(accessToken, config, store, registration.client.id),
    SubjectAuthorizationDenied,
  );

  const session = await app.fetch(
    new Request("https://aittadb.example.test/session", {
      headers: { accept: "application/json" },
    }),
  );
  await assertGenericDenial(session, 401, "login_required", [
    user.id,
    identity.email,
    "deletion",
  ]);

  const adminApp = createTestAittaDB(
    { ...env, ADMIN_SUBJECTS: user.id },
    store,
    identity,
  );
  const admin = await adminApp.fetch(
    new Request("https://aittadb.example.test/admin/clients", {
      headers: { accept: "application/json" },
    }),
  );
  await assertGenericDenial(admin, 403, "forbidden", [
    user.id,
    identity.email,
    "deletion",
  ]);

  const browserStorage = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      headers: { accept: "text/html" },
    }),
  );
  await assertGenericDenial(
    browserStorage,
    401,
    "Browser session unavailable",
    [user.id, identity.email, "deletion"],
  );

  const bearerStorage = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
    }),
  );
  await assertGenericDenial(bearerStorage, 401, "invalid_token", [
    user.id,
    identity.email,
    "deletion",
  ]);

  const storageWrite = await app.fetch(
    new Request("https://aittadb.example.test/storage/records/blocked", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ blocked: true }),
    }),
  );
  await assertGenericDenial(storageWrite, 401, "invalid_token", [
    user.id,
    identity.email,
    "deletion",
  ]);

  const userInfo = await app.fetch(
    new Request("https://aittadb.example.test/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  );
  await assertGenericDenial(userInfo, 401, "invalid_token", [
    user.id,
    identity.email,
    "deletion",
  ]);

  const introspection = await app.fetch(
    new Request("https://aittadb.example.test/oauth/introspect", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: registration.client.id,
        client_secret: registration.secret!,
        token: accessToken,
      }),
    }),
  );
  assert.deepEqual(await introspection?.json(), { active: false });

  const refresh = await app.fetch(
    new Request("https://aittadb.example.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        client_id: registration.client.id,
        client_secret: registration.secret!,
        refresh_token: refreshToken,
      }),
    }),
  );
  await assertGenericDenial(refresh, 400, "invalid_grant", [
    user.id,
    identity.email,
    "deletion",
  ]);

  assert.equal(store.refreshSuccessorWrites, 0);
  assert.equal(store.storageListReads, 0);
  assert.equal(store.storageMutations, 0);
  assert.equal(store.storageRateChecks, 0);
});

test("subjects without deletion jobs retain session, access, refresh, and storage", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" });
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const user = await store.findOrCreateUser(identity, nowSeconds());
  const registration = await createClientRegistration(
    {
      type: "confidential",
      name: "Active Subject Client",
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["openid", "offline_access", "storage.read", "storage.write"],
      origins: [],
    },
    store,
    nowSeconds(),
  );
  const tokens = await issueTokens({
    config,
    store,
    user,
    client: registration.client,
    scope: "openid offline_access storage.read storage.write",
    includeRefresh: true,
    now: nowSeconds(),
  });
  const app = createTestAittaDB(env, store, identity);

  assert.equal(
    (
      await app.fetch(
        new Request("https://aittadb.example.test/session", {
          headers: { accept: "application/json" },
        }),
      )
    )?.status,
    200,
  );
  assert.equal(
    (
      await app.fetch(
        new Request("https://aittadb.example.test/storage/records/active", {
          method: "PUT",
          headers: {
            authorization: `Bearer ${String(tokens.access_token)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ active: true }),
        }),
      )
    )?.status,
    200,
  );
  assert.equal(
    (
      await app.fetch(
        new Request("https://aittadb.example.test/userinfo", {
          headers: { authorization: `Bearer ${String(tokens.access_token)}` },
        }),
      )
    )?.status,
    200,
  );
  const refresh = await app.fetch(
    new Request("https://aittadb.example.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        client_id: registration.client.id,
        client_secret: registration.secret!,
        refresh_token: String(tokens.refresh_token),
      }),
    }),
  );
  assert.equal(refresh?.status, 200);
  assert.equal(
    typeof ((await refresh?.json()) as { access_token: unknown }).access_token,
    "string",
  );
});

async function assertGenericDenial(
  response: Response | null | undefined,
  status: number,
  error: string,
  forbidden: readonly string[],
): Promise<void> {
  assert.ok(response);
  assert.equal(response.status, status);
  const body = await response.text();
  assert.match(body, new RegExp(error));
  for (const value of forbidden) {
    assert.equal(
      body.toLowerCase().includes(value.toLowerCase()),
      false,
      value,
    );
  }
}
