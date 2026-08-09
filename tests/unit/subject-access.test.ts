import assert from "node:assert/strict";
import test from "node:test";

import {
  SubjectAuthorizationDenied,
  requireActiveSubject,
  startSubjectAccountDeletion,
} from "../../src/subject-access";
import { openApiSpec } from "../../src/openapi";
import { MemoryAuthStore } from "../../src/store/memory";
import type {
  AccountDeletionJobState,
  UpstreamIdentity,
} from "../../src/types";

const SUBJECT = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";

const identity = (email: string): UpstreamIdentity => ({
  email,
  fullName: null,
  displayName: email,
});

test("subject-active gate permits only subjects without a deletion job", async () => {
  const store = new MemoryAuthStore();
  await requireActiveSubject(store, SUBJECT);

  for (const state of [
    "pending",
    "running",
    "retryable",
    "completed",
  ] satisfies AccountDeletionJobState[]) {
    store.accountDeletionJobs.set(SUBJECT, {
      subject: SUBJECT,
      state,
      attempt: state === "pending" ? 0 : 1,
      availableAt: state === "completed" ? null : 20,
      createdAt: 10,
      updatedAt: 20,
      completedAt: state === "completed" ? 20 : null,
    });
    await assert.rejects(
      requireActiveSubject(store, SUBJECT),
      SubjectAuthorizationDenied,
      state,
    );
  }
});

test("subject-active gate fails closed on repository failure", async () => {
  const store = new MemoryAuthStore();
  store.getAccountDeletionJob = async () => {
    throw new Error("database_unavailable");
  };
  await assert.rejects(
    requireActiveSubject(store, SUBJECT),
    /database_unavailable/,
  );
});

test("deletion start guard rejects configured administrators before mutation", async () => {
  const store = new MemoryAuthStore();
  let starts = 0;
  const originalStart = store.startAccountDeletionJob.bind(store);
  store.startAccountDeletionJob = async (...args) => {
    starts += 1;
    return originalStart(...args);
  };

  await assert.rejects(
    startSubjectAccountDeletion(store, [ADMIN], ADMIN, 10),
    SubjectAuthorizationDenied,
  );
  assert.equal(starts, 0);
  assert.equal(await store.getAccountDeletionJob(ADMIN), null);
});

test("deletion start guard preserves non-admin idempotent repository semantics", async () => {
  const store = new MemoryAuthStore();
  const user = await store.findOrCreateUser(identity("member@example.test"), 1);

  const first = await startSubjectAccountDeletion(store, [ADMIN], user.id, 10);
  const repeated = await startSubjectAccountDeletion(
    store,
    [ADMIN],
    user.id,
    20,
  );

  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.deepEqual(repeated.job, first.job);
});

test("OpenAPI documents the shared denial without adding a deletion operation", () => {
  const serialized = JSON.stringify(openApiSpec);
  assert.match(serialized, /any internal account-deletion job/);
  assert.match(serialized, /refresh exchange creates no successor/);
  assert.equal(
    Object.keys(openApiSpec.paths).some((path) =>
      path.includes("account-deletion"),
    ),
    false,
  );
});
