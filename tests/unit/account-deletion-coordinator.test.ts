import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import {
  ACCOUNT_DELETION_COORDINATOR_RETRY_SECONDS,
  coordinateAccountDeletionBatch,
} from "../../src/account-deletion-coordinator";
import { storageFileWriteFence } from "../../src/storage-file-write-fence";
import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import type {
  AccountCredentialPurgeBatchResult,
  AccountRecordPurgeBatch,
  AuthStore,
  ClientView,
  LocalUser,
  StorageFileMetadata,
  StorageLimits,
  StorageRecord,
} from "../../src/types";
import { MemoryR2Bucket } from "../helpers";

const LIMITS: StorageLimits = {
  writesEnabled: true,
  globalMaxItems: 10_000,
  globalMaxBytes: 100_000_000,
  userMaxItems: 10_000,
  userMaxBytes: 100_000_000,
  namespaceMaxItems: 10_000,
  namespaceMaxBytes: 100_000_000,
};

class RetryingBucket extends MemoryR2Bucket {
  deleteFailures = 0;

  override async delete(key: string): Promise<void> {
    if (this.deleteFailures > 0) {
      this.deleteFailures -= 1;
      throw new Error("injected_r2_retirement_failure");
    }
    await super.delete(key);
  }
}

type InterruptedPhase =
  | "fences"
  | "credentials"
  | "records"
  | "files"
  | "finalization";

class InterruptingMemoryStore extends MemoryAuthStore {
  interrupted = false;

  constructor(private readonly phase: InterruptedPhase) {
    super();
  }

  override async stageExpiredAccountFileWriteFences(
    subject: string,
    attempt: number,
    now: number,
    limit: number,
  ): Promise<number> {
    const result = await super.stageExpiredAccountFileWriteFences(
      subject,
      attempt,
      now,
      limit,
    );
    this.interrupt("fences");
    return result;
  }

  override async purgeAccountCredentialsAndGrants(
    subject: string,
    limit: number,
  ): Promise<AccountCredentialPurgeBatchResult> {
    const result = await super.purgeAccountCredentialsAndGrants(subject, limit);
    this.interrupt("credentials");
    return result;
  }

  override async purgeAccountRecords(
    subject: string,
    limit: number,
  ): Promise<AccountRecordPurgeBatch> {
    const result = await super.purgeAccountRecords(subject, limit);
    this.interrupt("records");
    return result;
  }

  override async hasStorageFileOrphanRepairsForSubject(
    subject: string,
  ): Promise<boolean> {
    const result = await super.hasStorageFileOrphanRepairsForSubject(subject);
    this.interrupt("files");
    return result;
  }

  override async finalizeAccountDeletion(
    subject: string,
    attempt: number,
    now: number,
  ): Promise<boolean> {
    const result = await super.finalizeAccountDeletion(subject, attempt, now);
    if (result) this.interrupt("finalization");
    return result;
  }

  private interrupt(phase: InterruptedPhase): void {
    if (!this.interrupted && this.phase === phase) {
      this.interrupted = true;
      throw new Error(`injected_${phase}_interruption`);
    }
  }
}

interface D1Faults {
  failAfterFinalizationCommit?: boolean;
  finalizationFaultObserved?: boolean;
  failFenceDeleteRunOnce?: boolean;
}

interface Fixture {
  name: "memory" | "d1";
  store: AuthStore;
  bucket: RetryingBucket;
  sqlite: DatabaseSync | null;
  close(): void;
}

test("coordinator converges exact multi-batch state and atomically removes the subject", async (t) => {
  for (const name of ["memory", "d1"] as const) {
    await t.test(name, async () => {
      const fixture = await createFixture(name, true);
      try {
        const target = await createUser(
          fixture.store,
          `${name}-large-target`,
          1,
        );
        const control = await createUser(
          fixture.store,
          `${name}-large-control`,
          2,
        );
        const client = await createClient(fixture.store, `${name}-large`, 3);
        const targetObjectKeys = await seedLargeOwnedState(
          fixture.store,
          fixture.bucket,
          target,
          client,
        );
        await seedControlState(fixture.store, fixture.bucket, control, client);

        const actorHash = "a".repeat(64);
        const clientHash = "b".repeat(64);
        const rateKey = `storage-write:${"c".repeat(64)}`;
        await fixture.store.audit(
          "admin_client_updated",
          { actorHash, clientHash },
          1_000,
        );
        assert.equal(
          await fixture.store.rateLimit(rateKey, 5, 60, 1_000),
          true,
        );
        assert.equal(await fixture.store.countUsers(), 2);
        await fixture.store.startAccountDeletionJob(target.id, 1_000);

        let now = 1_000;
        const results = [];
        results.push(
          await coordinateAccountDeletionBatch(
            fixture.store,
            fixture.bucket,
            () => now,
          ),
        );
        assert.equal(results[0]!.deferred, 1);
        assert.ok(await fixture.store.getUser(target.id));
        assert.equal(await ownedAdminSubmissions(fixture, target.id), 0);

        while (results.at(-1)!.completed === 0) {
          now += ACCOUNT_DELETION_COORDINATOR_RETRY_SECONDS;
          results.push(
            await coordinateAccountDeletionBatch(
              fixture.store,
              fixture.bucket,
              () => now,
            ),
          );
          assert.ok(results.length < 8);
        }

        assert.equal(results.length, 3);
        assert.equal(await fixture.store.getUser(target.id), null);
        assert.ok(await fixture.store.getUser(control.id));
        assert.equal(await fixture.store.countUsers(), 1);
        assert.equal(await emailIndexContains(fixture, target.email), false);
        assert.equal(await ownedStateCount(fixture, target.id), 0);
        assert.equal(await ownedAdminSubmissions(fixture, control.id), 1);
        for (const key of targetObjectKeys) {
          assert.equal(await fixture.bucket.get(key), null);
        }
        assert.ok(await fixture.bucket.get("objects/control-object"));

        const completed = await fixture.store.getAccountDeletionJob(target.id);
        assert.equal(completed?.state, "completed");
        assert.equal(completed?.availableAt, null);
        assert.equal(
          await fixture.store.finalizeAccountDeletion(
            target.id,
            completed!.attempt,
            now + 1,
          ),
          true,
        );
        assert.deepEqual(
          await fixture.store.startAccountDeletionJob(target.id, now + 2),
          { created: false, job: completed },
        );

        const aggregate = JSON.stringify(results);
        for (const privateValue of [
          target.id,
          target.email,
          target.displayName,
          client.id,
          "target-record",
          "objects/target-object",
        ]) {
          assert.equal(aggregate.includes(privateValue), false);
        }
        const tombstone = JSON.stringify(completed);
        assert.equal(tombstone.includes(target.id), true);
        for (const privateValue of [
          target.email,
          target.displayName,
          client.id,
          "target-record",
          "objects/target-object",
        ]) {
          assert.equal(tombstone.includes(privateValue), false);
        }
        await assertSecurityRetention(
          fixture,
          actorHash,
          clientHash,
          rateKey,
          target,
        );
        await fixture.store.cleanup(1_301);
        assert.equal(await rateCounterExists(fixture, rateKey), false);
        assert.equal(await auditEventCount(fixture), 1);
        assertForeignKeysClean(fixture);
      } finally {
        fixture.close();
      }
    });
  }
});

test("coordinator resumes after interruption following every phase", async (t) => {
  for (const phase of [
    "fences",
    "credentials",
    "records",
    "files",
    "finalization",
  ] as const) {
    await t.test(phase, async () => {
      const store = new InterruptingMemoryStore(phase);
      const bucket = new RetryingBucket();
      const target = await createUser(store, `interrupt-${phase}`, 1);
      const client = await createClient(store, `interrupt-${phase}`, 2);
      await seedSmallOwnedState(store, bucket, target, client);
      await store.startAccountDeletionJob(target.id, 400);

      let now = 400;
      let result = await coordinateAccountDeletionBatch(
        store,
        bucket,
        () => now,
      );
      let calls = 1;
      while (result.completed === 0) {
        now += ACCOUNT_DELETION_COORDINATOR_RETRY_SECONDS;
        result = await coordinateAccountDeletionBatch(store, bucket, () => now);
        calls += 1;
        assert.ok(calls < 10);
      }

      assert.equal(store.interrupted, true);
      assert.equal(await store.getUser(target.id), null);
      assert.equal(store.usersByEmail.has(target.email), false);
      assert.equal(await bucket.get("objects/interruption-fence"), null);
      assert.equal(await bucket.get("objects/interruption-file"), null);
      assert.equal(store.storageFileWriteFences.size, 0);
      assert.equal(store.storageFileOrphanRepairs.size, 0);
    });
  }
});

test("pre-existing file fences allow deletion start, block finalization, and retire through repair", async (t) => {
  for (const name of ["memory", "d1"] as const) {
    await t.test(name, async () => {
      const fixture = await createFixture(name, true);
      try {
        const target = await createUser(fixture.store, `${name}-fence`, 1);
        const client = await createClient(fixture.store, `${name}-fence`, 2);
        const fence = storageFileWriteFence(
          target.id,
          client.id,
          "objects/preexisting-fence",
          0,
        );
        assert.equal(
          await fixture.store.reserveStorageFileWriteFence(fence),
          true,
        );
        await fixture.bucket.put(fence.r2Key, "untracked bytes");
        assert.equal(
          (await fixture.store.startAccountDeletionJob(target.id, 100)).created,
          true,
        );

        const [firstClaim] = await fixture.store.claimAccountDeletionJobs(
          100,
          300,
          1,
        );
        assert.ok(firstClaim);
        assert.equal(
          await fixture.store.finalizeAccountDeletion(
            target.id,
            firstClaim.attempt,
            101,
          ),
          false,
        );
        assert.equal(
          await fixture.store.retryAccountDeletionJob(
            target.id,
            firstClaim.attempt,
            101,
            310,
          ),
          true,
        );

        const [expiredClaim] = await fixture.store.claimAccountDeletionJobs(
          310,
          300,
          1,
        );
        assert.ok(expiredClaim);
        assert.equal(
          await fixture.store.finalizeAccountDeletion(
            target.id,
            expiredClaim.attempt,
            310,
          ),
          false,
        );
        assert.equal(
          await fixture.store.retryAccountDeletionJob(
            target.id,
            expiredClaim.attempt,
            310,
            340,
          ),
          true,
        );

        fixture.bucket.deleteFailures = 1;
        const deferred = await coordinateAccountDeletionBatch(
          fixture.store,
          fixture.bucket,
          () => 340,
        );
        assert.equal(deferred.deferred, 1);
        assert.equal(await writeFenceCount(fixture, target.id), 0);
        assert.equal(await repairCount(fixture, target.id), 1);
        assert.ok(await fixture.bucket.get(fence.r2Key));

        const completed = await coordinateAccountDeletionBatch(
          fixture.store,
          fixture.bucket,
          () => 370,
        );
        assert.equal(completed.completed, 1);
        assert.equal(await fixture.store.getUser(target.id), null);
        assert.equal(await fixture.bucket.get(fence.r2Key), null);
        assert.equal(await repairCount(fixture, target.id), 0);
        assertForeignKeysClean(fixture);
      } finally {
        fixture.close();
      }
    });
  }
});

test("stale attempts cannot finalize and an expired claim converges through a new attempt", async (t) => {
  for (const name of ["memory", "d1"] as const) {
    await t.test(name, async () => {
      const fixture = await createFixture(name, true);
      try {
        const target = await createUser(fixture.store, `${name}-stale`, 1);
        await fixture.store.startAccountDeletionJob(target.id, 100);
        const [first] = await fixture.store.claimAccountDeletionJobs(
          100,
          30,
          1,
        );
        const [second] = await fixture.store.claimAccountDeletionJobs(
          130,
          30,
          1,
        );
        assert.ok(first);
        assert.ok(second);
        assert.equal(second.attempt, first.attempt + 1);
        assert.equal(
          await fixture.store.finalizeAccountDeletion(
            target.id,
            first.attempt,
            131,
          ),
          false,
        );
        assert.equal(
          await coordinateAccountDeletionBatch(
            fixture.store,
            fixture.bucket,
            () => 131,
          ).then((result) => result.claimed),
          0,
        );
        const result = await coordinateAccountDeletionBatch(
          fixture.store,
          fixture.bucket,
          () => 160,
        );
        assert.equal(result.completed, 1);
        assert.equal(await fixture.store.getUser(target.id), null);
      } finally {
        fixture.close();
      }
    });
  }
});

test("concurrent coordinators claim a subject at most once", async (t) => {
  for (const name of ["memory", "d1"] as const) {
    await t.test(name, async () => {
      const fixture = await createFixture(name, true);
      try {
        const target = await createUser(fixture.store, `${name}-concurrent`, 1);
        await fixture.store.startAccountDeletionJob(target.id, 100);
        const results = await Promise.all([
          coordinateAccountDeletionBatch(
            fixture.store,
            fixture.bucket,
            () => 100,
          ),
          coordinateAccountDeletionBatch(
            fixture.store,
            fixture.bucket,
            () => 100,
          ),
        ]);
        assert.equal(
          results.reduce((total, result) => total + result.claimed, 0),
          1,
        );
        assert.equal(
          results.reduce((total, result) => total + result.completed, 0),
          1,
        );
        assert.equal(await fixture.store.getUser(target.id), null);
      } finally {
        fixture.close();
      }
    });
  }
});

test("late subject ownership writes fail at the repository and D1 boundaries", async (t) => {
  for (const name of ["memory", "d1"] as const) {
    await t.test(name, async () => {
      const fixture = await createFixture(name, true);
      try {
        const target = await createUser(fixture.store, `${name}-late`, 1);
        const control = await createUser(
          fixture.store,
          `${name}-late-control`,
          2,
        );
        const client = await createClient(fixture.store, `${name}-late`, 3);
        await seedAnonymousTransitions(fixture.store, client);
        await fixture.store.createAuthorizationRequest({
          id: "owned-request",
          clientId: client.id,
          redirectUri: client.redirectUris[0]!,
          scope: "openid",
          state: null,
          nonce: null,
          codeChallenge: "c".repeat(43),
          createdAt: 1,
          expiresAt: 1_000,
          userId: target.id,
          status: "approved",
        });
        await fixture.store.createRefreshFamily({
          id: "existing-family",
          userId: target.id,
          clientId: client.id,
          status: "active",
          createdAt: 1,
        });
        assert.equal(
          await fixture.store.getAccountDeletionJob(target.id),
          null,
        );
        await fixture.store.startAccountDeletionJob(target.id, 100);

        const rejectedWrites: Array<() => Promise<unknown>> = [
          () =>
            fixture.store.transitionAuthorizationRequest(
              "anonymous-request",
              "approved",
              target.id,
              101,
            ),
          () =>
            fixture.store.transitionDeviceGrant(
              "anonymous-user-code",
              "approved",
              target.id,
              101,
            ),
          () =>
            fixture.store.createAuthorizationRequest({
              id: "late-request",
              clientId: client.id,
              redirectUri: client.redirectUris[0]!,
              scope: "openid",
              state: null,
              nonce: null,
              codeChallenge: "d".repeat(43),
              createdAt: 101,
              expiresAt: 1_000,
              userId: target.id,
              status: "approved",
            }),
          () =>
            fixture.store.createAuthorizationCode({
              codeHash: "late-code",
              authRequestId: "owned-request",
              clientId: client.id,
              redirectUri: client.redirectUris[0]!,
              userId: target.id,
              scope: "openid",
              nonce: null,
              expiresAt: 1_000,
              consumedAt: null,
            }),
          () =>
            fixture.store.createDeviceGrant({
              id: "late-device",
              deviceCodeHash: "late-device-code",
              userCodeHash: "late-user-code",
              userCodeDisplay: "",
              clientId: client.id,
              scope: "openid",
              status: "approved",
              userId: target.id,
              createdAt: 101,
              expiresAt: 1_000,
              intervalSeconds: 5,
              lastPollAt: null,
              slowDownCount: 0,
            }),
          () => fixture.store.saveConsent(target.id, client.id, "openid", 101),
          () =>
            fixture.store.createRefreshFamily({
              id: "late-family",
              userId: target.id,
              clientId: client.id,
              status: "active",
              createdAt: 101,
            }),
          () =>
            fixture.store.createRefreshToken({
              id: "late-refresh",
              familyId: "existing-family",
              tokenHash: "late-refresh-hash",
              userId: target.id,
              clientId: client.id,
              scope: "openid",
              expiresAt: 1_000,
              usedAt: null,
              revokedAt: null,
            }),
          () =>
            fixture.store.revokeAccessTokenJti(
              "late-jti",
              target.id,
              1_000,
              101,
            ),
          () =>
            fixture.store.upsertStorageRecord(
              record(target.id, client.id, "late-record", 101),
              LIMITS,
            ),
          () =>
            fixture.store.upsertStorageFileMetadata(
              file(target.id, client.id, "late-file", "objects/late-file", 1),
              null,
              LIMITS,
            ),
          () =>
            fixture.store.claimAdminOperationSubmission(
              "late-admin",
              target.id,
              101,
              1_000,
            ),
        ];
        for (const write of rejectedWrites) {
          await assert.rejects(write, /account_deletion_subject_inactive/);
        }
        assert.equal(
          await fixture.store.reserveStorageFileWriteFence(
            storageFileWriteFence(
              target.id,
              client.id,
              "objects/late-fence",
              101,
            ),
          ),
          false,
        );
        assert.equal(
          await fixture.store.upsertStorageRecord(
            record(control.id, client.id, "control-write", 101),
            LIMITS,
          ),
          true,
        );

        if (fixture.sqlite) {
          assert.throws(
            () =>
              fixture
                .sqlite!.prepare(
                  "UPDATE account_deletion_jobs SET state = 'completed', available_at = NULL, completed_at = 101 WHERE subject = ?",
                )
                .run(target.id),
            /account_deletion_finalization_incomplete/,
          );
          assertForeignKeysClean(fixture);
        }
      } finally {
        fixture.close();
      }
    });
  }
});

test("foreign-owner object references keep coordinator work retryable", async (t) => {
  for (const name of ["memory", "d1"] as const) {
    await t.test(name, async () => {
      const fixture = await createFixture(name, true);
      try {
        const target = await createUser(fixture.store, `${name}-foreign`, 1);
        const control = await createUser(
          fixture.store,
          `${name}-foreign-control`,
          2,
        );
        const client = await createClient(fixture.store, `${name}-foreign`, 3);
        const r2Key = "objects/shared-foreign-reference";
        assert.equal(
          await fixture.store.upsertStorageFileMetadata(
            file(target.id, client.id, "target", r2Key, 1),
            null,
            LIMITS,
          ),
          true,
        );
        assert.equal(
          await fixture.store.upsertStorageFileMetadata(
            file(control.id, client.id, "control", r2Key, 1),
            null,
            LIMITS,
          ),
          true,
        );
        await fixture.bucket.put(r2Key, "shared");
        await fixture.store.startAccountDeletionJob(target.id, 100);

        const result = await coordinateAccountDeletionBatch(
          fixture.store,
          fixture.bucket,
          () => 100,
        );
        assert.equal(result.deferred, 1);
        assert.ok(await fixture.store.getUser(target.id));
        assert.equal(await repairCount(fixture, target.id), 1);
        assert.ok(await fixture.bucket.get(r2Key));
        assert.ok(
          await fixture.store.getStorageFileMetadata(
            control.id,
            client.id,
            "control",
          ),
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("D1 uncertain finalization commits are observed as completed", async () => {
  const faults: D1Faults = { failAfterFinalizationCommit: true };
  const fixture = await createFixture("d1", true, faults);
  try {
    const target = await createUser(fixture.store, "d1-uncertain", 1);
    await fixture.store.startAccountDeletionJob(target.id, 100);
    const result = await coordinateAccountDeletionBatch(
      fixture.store,
      fixture.bucket,
      () => 100,
    );
    assert.deepEqual(result, {
      claimed: 1,
      completed: 1,
      deferred: 0,
      leaseLost: 0,
    });
    assert.equal(faults.finalizationFaultObserved, true);
    assert.equal(await fixture.store.getUser(target.id), null);
    assert.equal(
      (await fixture.store.getAccountDeletionJob(target.id))?.state,
      "completed",
    );
    assertForeignKeysClean(fixture);
  } finally {
    fixture.close();
  }
});

test("D1 explicitly purges admin submissions when foreign keys are disabled", async () => {
  const fixture = await createFixture("d1", false);
  try {
    const target = await createUser(fixture.store, "d1-no-foreign-keys", 1);
    assert.equal(
      await fixture.store.claimAdminOperationSubmission(
        "no-foreign-keys-admin",
        target.id,
        2,
        1_000,
      ),
      true,
    );
    await fixture.store.startAccountDeletionJob(target.id, 100);
    assert.equal(
      (
        await coordinateAccountDeletionBatch(
          fixture.store,
          fixture.bucket,
          () => 100,
        )
      ).completed,
      1,
    );
    assert.equal(await ownedAdminSubmissions(fixture, target.id), 0);
    assert.equal(await fixture.store.getUser(target.id), null);
    assert.equal(
      Number(
        fixture.sqlite!.prepare("PRAGMA foreign_keys").get()?.foreign_keys,
      ),
      0,
    );
    assert.deepEqual(
      fixture.sqlite!.prepare("PRAGMA foreign_key_check").all(),
      [],
    );
  } finally {
    fixture.close();
  }
});

test("expired-fence cleanup persists repair before it can clear the fence", async () => {
  const faults: D1Faults = { failFenceDeleteRunOnce: true };
  const fixture = await createFixture("d1", true, faults);
  try {
    const target = await createUser(fixture.store, "d1-cleanup-fence", 1);
    const client = await createClient(fixture.store, "d1-cleanup-fence", 2);
    const fence = storageFileWriteFence(
      target.id,
      client.id,
      "objects/cleanup-fence",
      0,
    );
    assert.equal(await fixture.store.reserveStorageFileWriteFence(fence), true);

    await assert.rejects(
      fixture.store.cleanup(301),
      /injected_fence_delete_failure/,
    );
    assert.equal(await writeFenceCount(fixture, target.id), 1);
    assert.equal(await repairCount(fixture, target.id), 1);

    await fixture.store.cleanup(302);
    assert.equal(await writeFenceCount(fixture, target.id), 0);
    assert.equal(await repairCount(fixture, target.id), 1);
    assertForeignKeysClean(fixture);
  } finally {
    fixture.close();
  }
});

async function createFixture(
  name: "memory" | "d1",
  foreignKeys: boolean,
  faults: D1Faults = {},
): Promise<Fixture> {
  const bucket = new RetryingBucket();
  if (name === "memory") {
    return {
      name,
      store: new MemoryAuthStore(),
      bucket,
      sqlite: null,
      close: () => undefined,
    };
  }

  const sqlite = await migratedDatabase(foreignKeys);
  return {
    name,
    store: new D1AuthStore(sqliteD1(sqlite, faults)),
    bucket,
    sqlite,
    close: () => sqlite.close(),
  };
}

async function createUser(
  store: AuthStore,
  prefix: string,
  now: number,
): Promise<LocalUser> {
  return store.findOrCreateUser(
    {
      email: `${prefix}@example.test`,
      fullName: `${prefix} full name`,
      displayName: `${prefix} display name`,
    },
    now,
  );
}

async function createClient(
  store: AuthStore,
  prefix: string,
  now: number,
): Promise<ClientView> {
  return store.createClient(
    {
      type: "public",
      name: `${prefix} client`,
      redirectUris: [`https://${prefix}.example.test/callback`],
      scopes: ["openid", "storage.read", "storage.write", "storage.delete"],
      origins: [],
    },
    null,
    now,
  );
}

async function seedLargeOwnedState(
  store: AuthStore,
  bucket: RetryingBucket,
  user: LocalUser,
  client: ClientView,
): Promise<string[]> {
  for (let index = 0; index < 200; index += 1) {
    assert.equal(
      await store.upsertStorageRecord(
        record(user.id, client.id, `target-record-${index}`, index + 10),
        LIMITS,
      ),
      true,
    );
  }

  const objectKeys: string[] = [];
  for (let index = 0; index < 50; index += 1) {
    const r2Key = `objects/target-object-${index}`;
    assert.equal(
      await store.upsertStorageFileMetadata(
        file(user.id, client.id, `target-file-${index}`, r2Key, index + 10),
        null,
        LIMITS,
      ),
      true,
    );
    await bucket.put(r2Key, `target-${index}`);
    objectKeys.push(r2Key);
  }

  for (let index = 0; index < 100; index += 1) {
    assert.equal(
      await store.claimAdminOperationSubmission(
        `target-admin-${index}`,
        user.id,
        index + 10,
        index + 10_000,
      ),
      true,
    );
  }
  return objectKeys;
}

async function seedControlState(
  store: AuthStore,
  bucket: RetryingBucket,
  user: LocalUser,
  client: ClientView,
): Promise<void> {
  assert.equal(
    await store.upsertStorageRecord(
      record(user.id, client.id, "control-record", 20),
      LIMITS,
    ),
    true,
  );
  assert.equal(
    await store.upsertStorageFileMetadata(
      file(user.id, client.id, "control-file", "objects/control-object", 20),
      null,
      LIMITS,
    ),
    true,
  );
  await bucket.put("objects/control-object", "control");
  assert.equal(
    await store.claimAdminOperationSubmission(
      "control-admin",
      user.id,
      20,
      20_000,
    ),
    true,
  );
}

async function seedSmallOwnedState(
  store: AuthStore,
  bucket: RetryingBucket,
  user: LocalUser,
  client: ClientView,
): Promise<void> {
  assert.equal(
    await store.upsertStorageRecord(
      record(user.id, client.id, "interruption-record", 1),
      LIMITS,
    ),
    true,
  );
  assert.equal(
    await store.upsertStorageFileMetadata(
      file(
        user.id,
        client.id,
        "interruption-file",
        "objects/interruption-file",
        1,
      ),
      null,
      LIMITS,
    ),
    true,
  );
  await bucket.put("objects/interruption-file", "file");
  const fence = storageFileWriteFence(
    user.id,
    client.id,
    "objects/interruption-fence",
    0,
  );
  assert.equal(await store.reserveStorageFileWriteFence(fence), true);
  await bucket.put(fence.r2Key, "fenced");
  assert.equal(
    await store.claimAdminOperationSubmission(
      "interruption-admin",
      user.id,
      1,
      10_000,
    ),
    true,
  );
}

async function seedAnonymousTransitions(
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
    codeChallenge: "a".repeat(43),
    createdAt: 1,
    expiresAt: 2_000,
    userId: null,
    status: "pending",
  });
  await store.createDeviceGrant({
    id: "anonymous-device-id",
    deviceCodeHash: "anonymous-device-code",
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

function record(
  userId: string,
  clientId: string,
  key: string,
  now: number,
): StorageRecord {
  return {
    userId,
    clientId,
    key,
    valueJson: JSON.stringify({ key }),
    createdAt: now,
    updatedAt: now,
  };
}

function file(
  userId: string,
  clientId: string,
  key: string,
  r2Key: string,
  now: number,
): StorageFileMetadata {
  return {
    userId,
    clientId,
    key,
    r2Key,
    contentType: "application/octet-stream",
    size: 1,
    sha256: "0".repeat(64),
    createdAt: now,
    updatedAt: now,
  };
}

async function ownedAdminSubmissions(
  fixture: Fixture,
  subject: string,
): Promise<number> {
  if (fixture.store instanceof MemoryAuthStore) {
    return Array.from(fixture.store.adminOperationSubmissions.values()).filter(
      (submission) => submission.userId === subject,
    ).length;
  }
  return sqliteSubjectCount(
    fixture.sqlite!,
    "admin_operation_submissions",
    subject,
  );
}

async function emailIndexContains(
  fixture: Fixture,
  email: string,
): Promise<boolean> {
  if (fixture.store instanceof MemoryAuthStore) {
    return fixture.store.usersByEmail.has(email);
  }
  return Boolean(
    fixture
      .sqlite!.prepare("SELECT 1 AS present FROM users WHERE email = ?")
      .get(email),
  );
}

async function ownedStateCount(
  fixture: Fixture,
  subject: string,
): Promise<number> {
  if (fixture.store instanceof MemoryAuthStore) {
    const store = fixture.store;
    return [
      Number(store.users.has(subject)),
      Array.from(store.authRequests.values()).filter(
        (value) => value.userId === subject,
      ).length,
      Array.from(store.authCodes.values()).filter(
        (value) => value.userId === subject,
      ).length,
      Array.from(store.devices.values()).filter(
        (value) => value.userId === subject,
      ).length,
      Array.from(store.families.values()).filter(
        (value) => value.userId === subject,
      ).length,
      Array.from(store.refreshTokens.values()).filter(
        (value) => value.userId === subject,
      ).length,
      Array.from(store.consents.keys()).filter((key) =>
        key.startsWith(`${subject}:`),
      ).length,
      Array.from(store.revokedJtis.values()).filter(
        (value) => value.subject === subject,
      ).length,
      Array.from(store.storageRecords.values()).filter(
        (value) => value.userId === subject,
      ).length,
      Array.from(store.storageFiles.values()).filter(
        (value) => value.userId === subject,
      ).length,
      Array.from(store.storageFileWriteFences.values()).filter(
        (value) => value.userId === subject,
      ).length,
      Array.from(store.storageFileOrphanRepairs.values()).filter(
        (value) => value.userId === subject,
      ).length,
      Array.from(store.adminOperationSubmissions.values()).filter(
        (value) => value.userId === subject,
      ).length,
    ].reduce((total, count) => total + count, 0);
  }

  const sqlite = fixture.sqlite!;
  return (
    Number(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?")
        .get(subject)?.count ?? 0,
    ) +
    [
      "authorization_requests",
      "authorization_codes",
      "device_grants",
      "refresh_token_families",
      "refresh_tokens",
      "consents",
      "revoked_access_tokens",
      "storage_records",
      "storage_files",
      "storage_file_write_fences",
      "storage_file_orphan_repairs",
      "admin_operation_submissions",
    ].reduce(
      (total, table) => total + sqliteSubjectCount(sqlite, table, subject),
      0,
    )
  );
}

async function writeFenceCount(
  fixture: Fixture,
  subject: string,
): Promise<number> {
  if (fixture.store instanceof MemoryAuthStore) {
    return Array.from(fixture.store.storageFileWriteFences.values()).filter(
      (value) => value.userId === subject,
    ).length;
  }
  return sqliteSubjectCount(
    fixture.sqlite!,
    "storage_file_write_fences",
    subject,
  );
}

async function repairCount(fixture: Fixture, subject: string): Promise<number> {
  if (fixture.store instanceof MemoryAuthStore) {
    return Array.from(fixture.store.storageFileOrphanRepairs.values()).filter(
      (value) => value.userId === subject,
    ).length;
  }
  return sqliteSubjectCount(
    fixture.sqlite!,
    "storage_file_orphan_repairs",
    subject,
  );
}

async function assertSecurityRetention(
  fixture: Fixture,
  actorHash: string,
  clientHash: string,
  rateKey: string,
  target: LocalUser,
): Promise<void> {
  let auditData: Record<string, unknown>;
  if (fixture.store instanceof MemoryAuthStore) {
    assert.equal(fixture.store.audits.length, 1);
    auditData = fixture.store.audits[0]!.data;
  } else {
    const row = fixture
      .sqlite!.prepare(
        "SELECT data_json FROM audit_events ORDER BY id ASC LIMIT 1",
      )
      .get();
    assert.ok(row);
    auditData = JSON.parse(String(row.data_json)) as Record<string, unknown>;
  }
  assert.deepEqual(auditData, { actorHash, clientHash });
  const retained = JSON.stringify(auditData);
  assert.equal(retained.includes(target.id), false);
  assert.equal(retained.includes(target.email), false);
  assert.equal(retained.includes(target.displayName), false);
  assert.equal(await rateCounterExists(fixture, rateKey), true);
  assert.equal(rateKey.includes(target.id), false);
  assert.equal(rateKey.includes(target.email), false);
}

async function rateCounterExists(
  fixture: Fixture,
  key: string,
): Promise<boolean> {
  if (fixture.store instanceof MemoryAuthStore) {
    return fixture.store.counters.has(key);
  }
  return Boolean(
    fixture
      .sqlite!.prepare(
        "SELECT 1 AS present FROM rate_limit_counters WHERE key = ?",
      )
      .get(key),
  );
}

async function auditEventCount(fixture: Fixture): Promise<number> {
  if (fixture.store instanceof MemoryAuthStore) {
    return fixture.store.audits.length;
  }
  return Number(
    fixture.sqlite!.prepare("SELECT COUNT(*) AS count FROM audit_events").get()
      ?.count ?? 0,
  );
}

function assertForeignKeysClean(fixture: Fixture): void {
  if (!fixture.sqlite) return;
  assert.equal(
    Number(fixture.sqlite.prepare("PRAGMA foreign_keys").get()?.foreign_keys),
    1,
  );
  assert.deepEqual(
    fixture.sqlite.prepare("PRAGMA foreign_key_check").all(),
    [],
  );
}

function sqliteSubjectCount(
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

async function migratedDatabase(foreignKeys: boolean): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  const migrationUrl = new URL("../../db/migrations/", import.meta.url);
  const migrationNames = (await readdir(migrationUrl))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrationNames) {
    sqlite.exec(await readFile(new URL(name, migrationUrl), "utf8"));
  }
  return sqlite;
}

function sqliteD1(database: DatabaseSync, faults: D1Faults): D1Database {
  const prepared = new WeakMap<
    D1PreparedStatement,
    { query: string; values: SQLInputValue[] }
  >();
  return {
    prepare(query: string): D1PreparedStatement {
      const execution = { query, values: [] as SQLInputValue[] };
      const statement: D1PreparedStatement = {
        bind(...values: unknown[]): D1PreparedStatement {
          execution.values = values as SQLInputValue[];
          return statement;
        },
        async first<T>(): Promise<T | null> {
          return (
            (database.prepare(query).get(...execution.values) as
              | T
              | undefined) ?? null
          );
        },
        async all<T>(): Promise<D1Result<T>> {
          return {
            success: true,
            results: database.prepare(query).all(...execution.values) as T[],
          };
        },
        async run<T>(): Promise<D1Result<T>> {
          if (
            faults.failFenceDeleteRunOnce &&
            query.includes("DELETE FROM storage_file_write_fences")
          ) {
            faults.failFenceDeleteRunOnce = false;
            throw new Error("injected_fence_delete_failure");
          }
          const result = database.prepare(query).run(...execution.values);
          return {
            success: true,
            meta: { changes: Number(result.changes) },
          };
        },
      };
      prepared.set(statement, execution);
      return statement;
    },
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const executions = statements.map((statement) => {
        const execution = prepared.get(statement);
        assert.ok(execution);
        return execution;
      });
      const finalizationBatch = executions.some(
        ({ query }) =>
          query.includes("UPDATE account_deletion_jobs") &&
          query.includes("state = 'completed'"),
      );
      database.exec("BEGIN IMMEDIATE");
      let committed = false;
      try {
        const results = executions.map(({ query, values }) => {
          const result = database.prepare(query).run(...values);
          return {
            success: true,
            meta: { changes: Number(result.changes) },
          } as D1Result<T>;
        });
        database.exec("COMMIT");
        committed = true;
        if (finalizationBatch && faults.failAfterFinalizationCommit) {
          faults.failAfterFinalizationCommit = false;
          faults.finalizationFaultObserved = true;
          throw new Error("injected_finalization_uncertain_result");
        }
        return results;
      } catch (error) {
        if (!committed) database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
