import assert from "node:assert/strict";
import test from "node:test";

import { coordinateAccountDeletionBatch } from "../../src/account-deletion-coordinator";
import {
  ACCOUNT_DELETION_STATUS_COOKIE_NAME,
  sealAccountDeletionStatus,
} from "../../src/account-deletion-status";
import { loadConfig } from "../../src/config";
import { nowSeconds, publicJwk, verifyJwt } from "../../src/crypto";
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
import { createTestAittaDB, form, MemoryR2Bucket, testEnv } from "../helpers";

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

test("completed deletion re-registers the same email into one isolated new subject", async () => {
  const bucket = new MemoryR2Bucket();
  const env = await testEnv({
    BUCKET: bucket,
    FEATURE_OAUTH_APPS_ENABLED: "true",
    PRIVACY_CONTROLLER_NAME: "AittaDB Test Operator",
    PRIVACY_CONTACT_EMAIL: "privacy@example.test",
  });
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const issuedAt = nowSeconds();
  const oldUser = await store.findOrCreateUser(identity, issuedAt);
  const registration = await createClientRegistration(
    {
      type: "public",
      name: "Post-deletion isolation client",
      redirectUris: ["https://client.example.test/callback"],
      scopes: [
        "openid",
        "email",
        "profile",
        "offline_access",
        "storage.read",
        "storage.write",
        "storage.delete",
      ],
      origins: [],
    },
    store,
    issuedAt,
  );
  const scope =
    "openid email profile offline_access storage.read storage.write storage.delete";
  await store.saveConsent(oldUser.id, registration.client.id, scope, issuedAt);
  const oldTokens = await issueTokens({
    config,
    store,
    user: oldUser,
    client: registration.client,
    scope,
    includeRefresh: true,
    now: issuedAt,
  });
  const oldAccessToken = String(oldTokens.access_token);
  const oldIdToken = String(oldTokens.id_token);
  const oldRefreshToken = String(oldTokens.refresh_token);
  const app = createTestAittaDB(env, store, identity);

  assert.equal(
    (
      await app.fetch(
        new Request("https://aittadb.example.test/storage/records/old-record", {
          method: "PUT",
          headers: {
            authorization: `Bearer ${oldAccessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ owner: "old" }),
        }),
      )
    )?.status,
    200,
  );
  assert.equal(
    (
      await app.fetch(
        new Request("https://aittadb.example.test/storage/files/old-file", {
          method: "PUT",
          headers: {
            authorization: `Bearer ${oldAccessToken}`,
            "content-type": "text/plain",
          },
          body: "old bytes",
        }),
      )
    )?.status,
    200,
  );
  const oldFile = await store.getStorageFileMetadata(
    oldUser.id,
    registration.client.id,
    "old-file",
  );
  assert.ok(oldFile);
  await store.revokeAccessTokenJti(
    "old-owned-revocation",
    oldUser.id,
    issuedAt + config.accessTokenTtlSeconds,
    issuedAt,
  );
  assert.equal(
    await store.claimAdminOperationSubmission(
      "old-owned-admin-submission",
      oldUser.id,
      issuedAt,
      issuedAt + 600,
    ),
    true,
  );
  const statusHandle = await sealAccountDeletionStatus(
    oldUser.id,
    identity.email,
    config,
    issuedAt,
  );
  await store.startAccountDeletionJob(oldUser.id, issuedAt);

  const completed = await coordinateAccountDeletionBatch(
    store,
    bucket,
    () => issuedAt + 1,
  );
  assert.deepEqual(completed, {
    claimed: 1,
    completed: 1,
    deferred: 0,
    leaseLost: 0,
  });
  assert.equal(
    (await store.getAccountDeletionJob(oldUser.id))?.state,
    "completed",
  );
  assert.equal(await store.getUser(oldUser.id), null);
  assert.equal(await store.getUserByEmail(identity.email), null);
  assert.equal(await store.countUsers(), 0);
  assert.equal(
    await store.hasConsent(oldUser.id, registration.client.id, scope),
    false,
  );
  assert.equal(
    Array.from(store.families.values()).some(
      (family) => family.userId === oldUser.id,
    ),
    false,
  );
  assert.equal(
    Array.from(store.refreshTokens.values()).some(
      (token) => token.userId === oldUser.id,
    ),
    false,
  );
  assert.equal(
    Array.from(store.revokedJtis.values()).some(
      (revocation) => revocation.subject === oldUser.id,
    ),
    false,
  );
  assert.equal(
    Array.from(store.adminOperationSubmissions.values()).some(
      (submission) => submission.userId === oldUser.id,
    ),
    false,
  );
  assert.equal(
    Array.from(store.storageRecords.values()).some(
      (record) => record.userId === oldUser.id,
    ),
    false,
  );
  assert.equal(
    Array.from(store.storageFiles.values()).some(
      (file) => file.userId === oldUser.id,
    ),
    false,
  );
  assert.equal(await bucket.get(oldFile.r2Key), null);

  await assert.rejects(
    verifyAccessToken(oldAccessToken, config, store, registration.client.id),
    SubjectAuthorizationDenied,
  );
  const oldUserInfo = await app.fetch(
    new Request("https://aittadb.example.test/userinfo", {
      headers: { authorization: `Bearer ${oldAccessToken}` },
    }),
  );
  await assertGenericDenial(oldUserInfo, 401, "invalid_token", [
    oldUser.id,
    identity.email,
  ]);
  const idAsAccess = await app.fetch(
    new Request("https://aittadb.example.test/userinfo", {
      headers: { authorization: `Bearer ${oldIdToken}` },
    }),
  );
  await assertGenericDenial(idAsAccess, 401, "invalid_token", [
    oldUser.id,
    identity.email,
  ]);
  const oldRefresh = await app.fetch(
    new Request("https://aittadb.example.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        client_id: registration.client.id,
        refresh_token: oldRefreshToken,
      }),
    }),
  );
  await assertGenericDenial(oldRefresh, 400, "invalid_grant", [
    oldUser.id,
    identity.email,
  ]);

  const verifiedOldTokens = new Map<
    string,
    Awaited<ReturnType<typeof verifyJwt>>
  >();
  for (const [tokenUse, token] of [
    ["access", oldAccessToken],
    ["id", oldIdToken],
  ] as const) {
    const verified = await verifyJwt(
      token,
      [publicJwk(config.jwtPrivateJwk, config.jwtKeyId)],
      {
        issuer: config.issuerUrl,
        audience: registration.client.id,
        now: issuedAt + 1,
      },
    );
    assert.equal(verified.claims.sub, oldUser.id);
    assert.equal(verified.claims.token_use, tokenUse);
    verifiedOldTokens.set(tokenUse, verified);
    await assert.rejects(
      verifyJwt(token, [publicJwk(config.jwtPrivateJwk, config.jwtKeyId)], {
        issuer: config.issuerUrl,
        audience: registration.client.id,
        now: issuedAt + config.accessTokenTtlSeconds + 1,
      }),
      /expired_token/,
    );
  }

  const statusBeforeRegistration = await app.fetch(
    new Request("https://aittadb.example.test/account/deletion", {
      headers: {
        accept: "application/json",
        cookie: `${ACCOUNT_DELETION_STATUS_COOKIE_NAME}=${statusHandle}`,
      },
    }),
  );
  assert.equal(statusBeforeRegistration?.status, 200);
  const statusBeforeBody = await statusBeforeRegistration!.text();
  assert.deepEqual(
    (JSON.parse(statusBeforeBody) as { data: Record<string, unknown> }).data,
    { status: "completed" },
  );
  assert.equal(await store.countUsers(), 0);
  for (const forbidden of [oldUser.id, identity.email]) {
    assert.equal(statusBeforeBody.includes(forbidden), false);
  }

  const firstSession = await app.fetch(
    new Request("https://aittadb.example.test/session", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(firstSession?.status, 200);
  const firstSessionBody = (await firstSession!.json()) as {
    data: { user: { sub: string } };
  };
  const newSubject = firstSessionBody.data.user.sub;
  assert.notEqual(newSubject, oldUser.id);
  assert.equal(await store.countUsers(), 1);

  const repeatedSession = await app.fetch(
    new Request("https://aittadb.example.test/session", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(repeatedSession?.status, 200);
  assert.equal(
    ((await repeatedSession!.json()) as { data: { user: { sub: string } } })
      .data.user.sub,
    newSubject,
  );
  assert.equal(await store.countUsers(), 1);

  const newUser = await store.getUser(newSubject);
  assert.ok(newUser);
  assert.equal(newUser.email, identity.email);
  assert.equal(
    await store.hasConsent(newSubject, registration.client.id, scope),
    false,
  );
  const newTokens = await issueTokens({
    config,
    store,
    user: newUser,
    client: registration.client,
    scope,
    includeRefresh: false,
    now: nowSeconds(),
  });
  const verifiedNewAccess = await verifyAccessToken(
    String(newTokens.access_token),
    config,
    store,
    registration.client.id,
  );
  assert.equal(verifiedNewAccess.claims.sub, newSubject);
  assert.notEqual(
    verifiedNewAccess.claims.sub,
    verifiedOldTokens.get("access")!.claims.sub,
  );

  for (const collection of ["records", "files"]) {
    const response = await app.fetch(
      new Request(`https://aittadb.example.test/storage/${collection}`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${String(newTokens.access_token)}`,
        },
      }),
    );
    assert.equal(response?.status, 200);
    assert.deepEqual(
      ((await response!.json()) as { data: { items: unknown[] } }).data.items,
      [],
    );
  }

  const statusAfterRegistration = await app.fetch(
    new Request("https://aittadb.example.test/account/deletion", {
      headers: {
        accept: "application/json",
        cookie: `${ACCOUNT_DELETION_STATUS_COOKIE_NAME}=${statusHandle}`,
      },
    }),
  );
  assert.equal(statusAfterRegistration?.status, 200);
  const statusAfterBody = await statusAfterRegistration!.text();
  assert.deepEqual(
    (JSON.parse(statusAfterBody) as { data: Record<string, unknown> }).data,
    { status: "completed" },
  );
  assert.equal(await store.countUsers(), 1);
  for (const forbidden of [oldUser.id, newSubject, identity.email]) {
    assert.equal(statusAfterBody.includes(forbidden), false);
  }

  const privacy = await app.fetch(
    new Request("https://aittadb.example.test/privacy", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(privacy?.status, 200);
  const privacyBody = await privacy!.text();
  for (const forbidden of [oldUser.id, newSubject, identity.email]) {
    assert.equal(privacyBody.includes(forbidden), false);
  }
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
