import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_DELETION_CONFIRMATION_PHRASE,
  ACCOUNT_DELETION_CONFIRMATION_TTL_SECONDS,
  openAccountDeletionConfirmation,
  sealAccountDeletionConfirmation,
} from "../../src/account-deletion-request";
import {
  ACCOUNT_DELETION_STATUS_COOKIE_NAME,
  ACCOUNT_DELETION_STATUS_TTL_SECONDS,
  sealAccountDeletionStatus,
} from "../../src/account-deletion-status";
import {
  accountDeletionCoordinatorDeferredTelemetry,
  accountDeletionCoordinatorFailureTelemetry,
  type AccountDeletionCoordinatorDeferredPhase,
  type AccountDeletionCoordinatorFailurePhase,
} from "../../src/account-deletion-coordinator";
import { loadConfig } from "../../src/config";
import { nowSeconds } from "../../src/crypto";
import { createAittaDBWithStore, type AittaDBApp } from "../../src/handler";
import type { UpstreamIdentityProvider } from "../../src/identity";
import type { CleanupReport } from "../../src/store/cleanup";
import {
  AccountCredentialPurgeFailure,
  accountCredentialPurgeFailureTelemetry,
  type AccountCredentialPurgeFailurePhase,
} from "../../src/store/account-credential-purge";
import { MemoryAuthStore } from "../../src/store/memory";
import type {
  AccountDeletionJob,
  AccountDeletionJobStartResult,
  AppConfig,
  LocalUser,
  RuntimeEnv,
  UpstreamIdentity,
} from "../../src/types";
import { MemoryR2Bucket, cookieValue, form, testEnv } from "../helpers";

const ISSUER = "https://aittadb.example.test";
const REQUEST_ORIGIN = "https://sites-dispatch.example.test";
const OWNER_IDENTITY: UpstreamIdentity = {
  email: "deletion-owner@example.test",
  fullName: "Deletion Owner",
  displayName: "Deletion Owner",
};
const OTHER_IDENTITY: UpstreamIdentity = {
  email: "other-owner@example.test",
  fullName: "Other Owner",
  displayName: "Other Owner",
};

class ObservedAccountDeletionStore extends MemoryAuthStore {
  findOrCreateCalls = 0;
  userByEmailCalls = 0;
  startCalls = 0;
  claimCalls = 0;
  cleanupCalls = 0;
  getJobCalls = 0;
  rateKeys: string[] = [];
  rejectCoordinator = false;
  coordinatorFailurePhase: AccountDeletionCoordinatorFailurePhase | null = null;
  coordinatorDeferredPhase: AccountDeletionCoordinatorDeferredPhase | null =
    null;
  coordinatorCredentialFailurePhase: AccountCredentialPurgeFailurePhase | null =
    null;
  coordinatorDeferred = false;

  override async findOrCreateUser(
    identity: UpstreamIdentity,
    now: number,
  ): Promise<LocalUser> {
    this.findOrCreateCalls += 1;
    return super.findOrCreateUser(identity, now);
  }

  override async getUserByEmail(email: string): Promise<LocalUser | null> {
    this.userByEmailCalls += 1;
    return super.getUserByEmail(email);
  }

  override async startAccountDeletionJob(
    subject: string,
    now: number,
  ): Promise<AccountDeletionJobStartResult> {
    this.startCalls += 1;
    return super.startAccountDeletionJob(subject, now);
  }

  override async claimAccountDeletionJobs(
    now: number,
    leaseSeconds: number,
    limit: number,
  ): Promise<AccountDeletionJob[]> {
    this.claimCalls += 1;
    if (this.rejectCoordinator) throw new Error("synthetic_background_failure");
    return super.claimAccountDeletionJobs(now, leaseSeconds, limit);
  }

  override async cleanup(now: number): Promise<CleanupReport> {
    this.cleanupCalls += 1;
    return super.cleanup(now);
  }

  override async getAccountDeletionJob(
    subject: string,
  ): Promise<AccountDeletionJob | null> {
    this.getJobCalls += 1;
    return super.getAccountDeletionJob(subject);
  }

  override async purgeAccountCredentialsAndGrants(
    subject: string,
    limit: number,
  ) {
    if (this.coordinatorCredentialFailurePhase) {
      throw new AccountCredentialPurgeFailure(
        this.coordinatorCredentialFailurePhase,
      );
    }
    if (this.coordinatorFailurePhase === "credentials") {
      throw new Error("synthetic_phase_failure_with_private_context");
    }
    const result = await super.purgeAccountCredentialsAndGrants(subject, limit);
    if (
      !this.coordinatorDeferred &&
      this.coordinatorDeferredPhase === "credentials"
    ) {
      this.coordinatorDeferred = true;
      return { ...result, done: false };
    }
    return result;
  }

  override async rateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
    now: number,
  ): Promise<boolean> {
    this.rateKeys.push(key);
    return super.rateLimit(key, limit, windowSeconds, now);
  }
}

class ObservedR2Bucket extends MemoryR2Bucket {
  calls = 0;

  override async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown> {
    this.calls += 1;
    return super.put(key, value, options);
  }

  override async get(key: string): Promise<R2ObjectBody | null> {
    this.calls += 1;
    return super.get(key);
  }

  override async delete(key: string): Promise<void> {
    this.calls += 1;
    return super.delete(key);
  }
}

test("session HTML and hypermedia expose one eligible account deletion form", async () => {
  const fixture = await createFixture();
  const controls = await sessionControls(fixture);
  assert.equal(controls.action.method, "POST");
  assert.equal(controls.action.href, `${ISSUER}/account/deletion`);
  assert.equal(controls.action.type, "application/x-www-form-urlencoded");
  assert.deepEqual(
    controls.action.fields.map((field) => field.name),
    ["csrf_token", "confirmation_token", "confirmation"],
  );
  assert.equal(controls.confirmationField.min_length, 17);
  assert.equal(controls.confirmationField.max_length, 17);
  assert.doesNotMatch(controls.confirmationToken, new RegExp(fixture.user.id));
  assert.doesNotMatch(
    controls.confirmationToken,
    new RegExp(fixture.user.email),
  );

  const htmlResponse = await fetchResponse(
    fixture.app,
    new Request(`${REQUEST_ORIGIN}/session`, {
      headers: { accept: "text/html", cookie: controls.cookie },
    }),
  );
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(html, /action="\/account\/deletion"/);
  for (const name of ["csrf_token", "confirmation_token", "confirmation"]) {
    assert.match(html, new RegExp(`name="${name}"`));
  }
  assert.match(html, /delete my account/);

  const adminFixture = await createFixture({ admin: true });
  const adminJson = await sessionDocument(adminFixture);
  assert.equal(
    adminJson.actions.some(
      (action) => action.name === "request-account-deletion",
    ),
    false,
  );
  const adminHtml = await fetchResponse(
    adminFixture.app,
    new Request(`${REQUEST_ORIGIN}/session`, {
      headers: { accept: "text/html" },
    }),
  );
  assert.doesNotMatch(await adminHtml.text(), /action="\/account\/deletion"/);

  const reserved = await fetchResponse(
    fixture.app,
    new Request(`${REQUEST_ORIGIN}/account/deletion`, {
      headers: { accept: "application/json" },
    }),
  );
  assertGenericStatusRejection(reserved);
  await drainScheduled(fixture);
  await drainScheduled(adminFixture);
});

test("the first valid request returns coarse 202 representations and nudges once", async () => {
  const hypermediaFixture = await createFixture();
  const controls = await sessionControls(hypermediaFixture);
  hypermediaFixture.store.startCalls = 0;
  hypermediaFixture.store.claimCalls = 0;
  hypermediaFixture.scheduled.length = 0;

  const response = await postDeletion(hypermediaFixture, controls, {
    accept: "application/vnd.aittadb+json; version=0.1",
  });
  assert.equal(response.status, 202);
  assert.match(response.headers.get("content-type") ?? "", /vnd\.aittadb/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const statusCookie = response.headers.get("set-cookie") ?? "";
  assert.match(
    statusCookie,
    new RegExp(`^${ACCOUNT_DELETION_STATUS_COOKIE_NAME}=v1\\.`),
  );
  assert.match(statusCookie, /Path=\/account\/deletion/);
  assert.match(statusCookie, /HttpOnly/);
  assert.match(statusCookie, /Secure/);
  assert.match(statusCookie, /SameSite=Lax/);
  assert.match(statusCookie, /Max-Age=604800/);
  assert.doesNotMatch(statusCookie, /Domain=/i);
  const body = await response.text();
  const payload = JSON.parse(body) as Record<string, unknown>;
  assert.deepEqual(payload.data, { accepted: true });
  assert.deepEqual(
    (payload.actions as HypermediaActionValue[]).map((candidate) => ({
      name: candidate.name,
      method: candidate.method,
      href: candidate.href,
    })),
    [
      {
        name: "read-account-deletion-status",
        method: "GET",
        href: `${ISSUER}/account/deletion`,
      },
    ],
  );
  assert.deepEqual(Object.keys(payload).sort(), [
    "actions",
    "api_version",
    "data",
    "id",
    "links",
    "type",
  ]);
  assertSafeAcceptedEvidence(
    body,
    hypermediaFixture.user,
    controls,
    hypermediaFixture.store,
  );
  assert.equal(hypermediaFixture.store.startCalls, 1);
  assert.equal(hypermediaFixture.scheduled.length, 1);
  await drainScheduled(hypermediaFixture);
  assert.equal(hypermediaFixture.store.claimCalls, 1);

  const htmlFixture = await createFixture();
  const htmlControls = await sessionControls(htmlFixture);
  htmlFixture.scheduled.length = 0;
  const htmlResponse = await postDeletion(htmlFixture, htmlControls, {
    accept: "text/html",
    json: true,
  });
  assert.equal(htmlResponse.status, 202);
  assert.match(htmlResponse.headers.get("content-type") ?? "", /text\/html/);
  const html = await htmlResponse.text();
  assert.match(html, /Deletion has started/);
  assert.match(html, /acceptance, not completion/);
  assert.match(html, /href="\/account\/deletion"[^>]*>View deletion status/);
  assertSafeAcceptedEvidence(
    html,
    htmlFixture.user,
    htmlControls,
    htmlFixture.store,
  );
  assert.equal(htmlFixture.scheduled.length, 1);
  await drainScheduled(htmlFixture);
});

test("accepted status handle survives reload and resolves the old subject directly", async () => {
  const fixture = await createFixture({ rejectCoordinator: true });
  const controls = await sessionControls(fixture);
  fixture.scheduled.length = 0;
  const accepted = await postDeletion(fixture, controls);
  assert.equal(accepted.status, 202);
  const handle = cookieValue(accepted, ACCOUNT_DELETION_STATUS_COOKIE_NAME);
  await drainScheduled(fixture);

  fixture.store.findOrCreateCalls = 0;
  fixture.store.userByEmailCalls = 0;
  fixture.store.getJobCalls = 0;
  fixture.store.claimCalls = 0;
  fixture.store.cleanupCalls = 0;
  fixture.scheduled.length = 0;
  for (let reload = 0; reload < 2; reload += 1) {
    const response = await fetchResponse(
      fixture.app,
      statusRequest(handle, {
        accept: "application/vnd.aittadb+json; version=0.1",
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();
    const document = JSON.parse(body) as {
      data: Record<string, unknown>;
      actions: HypermediaActionValue[];
    };
    assert.deepEqual(document.data, { status: "pending" });
    assert.deepEqual(
      document.actions.map((candidate) => ({
        name: candidate.name,
        method: candidate.method,
        href: candidate.href,
      })),
      [
        {
          name: "refresh-account-deletion-status",
          method: "GET",
          href: `${ISSUER}/account/deletion`,
        },
      ],
    );
    assertSafeStatusEvidence(body, fixture.user);
    assert.equal(fixture.scheduled.length, 1);
    await drainScheduled(fixture);
  }
  assert.equal(fixture.store.getJobCalls, 2);
  assert.equal(fixture.store.claimCalls, 2);
  assert.equal(fixture.store.findOrCreateCalls, 0);
  assert.equal(fixture.store.userByEmailCalls, 0);
  assert.equal(fixture.store.cleanupCalls, 0);
});

test("status states expose only their matching HTML and hypermedia action", async () => {
  const fixture = await createFixture({ rejectCoordinator: true });
  await fixture.store.startAccountDeletionJob(fixture.user.id, 100);
  const handle = await sealAccountDeletionStatus(
    fixture.user.id,
    fixture.user.email,
    fixture.config,
    nowSeconds(),
  );
  const cases = [
    {
      internal: "pending" as const,
      status: "pending",
      action: "refresh-account-deletion-status",
      label: "Refresh status",
      href: "/account/deletion",
    },
    {
      internal: "running" as const,
      status: "running",
      action: "refresh-account-deletion-status",
      label: "Refresh status",
      href: "/account/deletion",
    },
    {
      internal: "retryable" as const,
      status: "retry",
      action: "retry-account-deletion",
      label: "Retry deletion",
      href: "/account/deletion",
    },
    {
      internal: "completed" as const,
      status: "completed",
      action: "sign-out",
      label: "Sign out",
      href: "/signout-with-chatgpt?return_to=%2F",
    },
  ];

  for (const current of cases) {
    fixture.store.accountDeletionJobs.set(fixture.user.id, {
      subject: fixture.user.id,
      state: current.internal,
      attempt: 91,
      availableAt: current.internal === "completed" ? null : 123_456,
      createdAt: 123_450,
      updatedAt: 123_455,
      completedAt: current.internal === "completed" ? 123_455 : null,
    });
    fixture.scheduled.length = 0;
    const jsonResponse = await fetchResponse(
      fixture.app,
      statusRequest(handle, { accept: "application/json" }),
    );
    assert.equal(jsonResponse.status, 200);
    const jsonBody = await jsonResponse.text();
    const document = JSON.parse(jsonBody) as {
      data: Record<string, unknown>;
      actions: HypermediaActionValue[];
    };
    assert.deepEqual(document.data, { status: current.status });
    assert.equal(document.actions.length, 1);
    assert.equal(document.actions[0]?.name, current.action);
    assert.equal(document.actions[0]?.method, "GET");
    assert.equal(
      document.actions[0]?.href,
      current.href.startsWith("/") ? `${ISSUER}${current.href}` : current.href,
    );
    assertSafeStatusEvidence(jsonBody, fixture.user);

    const htmlResponse = await fetchResponse(
      fixture.app,
      statusRequest(handle, { accept: "text/html" }),
    );
    assert.equal(htmlResponse.status, 200);
    const htmlBody = await htmlResponse.text();
    const actionNav = htmlBody.match(
      /<nav class="actions" aria-label="Available actions">.*?<\/nav>/,
    )?.[0];
    assert.ok(actionNav);
    assert.match(actionNav, new RegExp(`href="${escapeRegExp(current.href)}"`));
    assert.match(actionNav, new RegExp(`>${escapeRegExp(current.label)}</a>`));
    assert.deepEqual(
      [...actionNav.matchAll(/href="([^"]+)"/g)].map((match) => match[1]),
      [current.href],
    );
    assertSafeStatusEvidence(htmlBody, fixture.user);
    assert.equal(
      fixture.scheduled.length,
      current.status === "completed" ? 0 : 2,
    );
    await drainScheduled(fixture);
  }
});

test("invalid status handles perform no repository, R2, cleanup, or coordinator work", async () => {
  const fixture = await createFixture({ rejectCoordinator: true });
  const now = nowSeconds();
  const valid = await sealAccountDeletionStatus(
    fixture.user.id,
    fixture.user.email,
    fixture.config,
    now,
  );
  const expired = await sealAccountDeletionStatus(
    fixture.user.id,
    fixture.user.email,
    fixture.config,
    now - ACCOUNT_DELETION_STATUS_TTL_SECONDS,
  );
  const wrongIssuer = await sealAccountDeletionStatus(
    fixture.user.id,
    fixture.user.email,
    { ...fixture.config, issuerUrl: "https://wrong-issuer.example.test" },
    now,
  );
  const wrongKeyId = await sealAccountDeletionStatus(
    fixture.user.id,
    fixture.user.email,
    { ...fixture.config, jwtKeyId: "wrong-key-id" },
    now,
  );
  const wrongKey = await sealAccountDeletionStatus(
    fixture.user.id,
    fixture.user.email,
    loadConfig(await testEnv(), ISSUER),
    now,
  );
  const tampered = `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`;

  fixture.store.findOrCreateCalls = 0;
  fixture.store.userByEmailCalls = 0;
  fixture.store.getJobCalls = 0;
  fixture.store.claimCalls = 0;
  fixture.store.cleanupCalls = 0;
  fixture.store.rateKeys.length = 0;
  fixture.bucket.calls = 0;
  fixture.scheduled.length = 0;

  for (const handle of [
    null,
    "invalid",
    expired,
    tampered,
    wrongIssuer,
    wrongKeyId,
    wrongKey,
  ]) {
    fixture.identity.current = OWNER_IDENTITY;
    const response = await fetchResponse(fixture.app, statusRequest(handle));
    assertGenericStatusRejection(response);
  }
  fixture.identity.current = null;
  assertGenericStatusRejection(
    await fetchResponse(fixture.app, statusRequest(valid)),
  );
  fixture.identity.current = OTHER_IDENTITY;
  assertGenericStatusRejection(
    await fetchResponse(fixture.app, statusRequest(valid)),
  );

  fixture.identity.current = OWNER_IDENTITY;
  const unsupportedAccept = await fetchResponse(
    fixture.app,
    statusRequest(valid, { accept: "image/png" }),
  );
  assert.equal(unsupportedAccept.status, 406);
  assert.equal(unsupportedAccept.headers.get("cache-control"), "no-store");
  const unsupportedMethod = await fetchResponse(
    fixture.app,
    statusRequest(valid, { method: "PUT" }),
  );
  assert.equal(unsupportedMethod.status, 404);
  assert.equal(unsupportedMethod.headers.get("cache-control"), "no-store");

  assert.equal(fixture.store.findOrCreateCalls, 0);
  assert.equal(fixture.store.userByEmailCalls, 0);
  assert.equal(fixture.store.getJobCalls, 0);
  assert.equal(fixture.store.claimCalls, 0);
  assert.equal(fixture.store.cleanupCalls, 0);
  assert.equal(fixture.bucket.calls, 0);
  assert.deepEqual(fixture.store.rateKeys, []);
  assert.deepEqual(fixture.scheduled, []);
});

test("valid status handles fail coarsely without scheduling when durable state is unavailable", async () => {
  const missingJob = await createFixture({ rejectCoordinator: true });
  const missingJobHandle = await sealAccountDeletionStatus(
    missingJob.user.id,
    missingJob.user.email,
    missingJob.config,
    nowSeconds(),
  );
  missingJob.store.getJobCalls = 0;
  missingJob.store.claimCalls = 0;
  missingJob.store.cleanupCalls = 0;
  missingJob.scheduled.length = 0;
  assertGenericStatusRejection(
    await fetchResponse(missingJob.app, statusRequest(missingJobHandle)),
  );
  assert.equal(missingJob.store.getJobCalls, 1);
  assert.equal(missingJob.store.claimCalls, 0);
  assert.equal(missingJob.store.cleanupCalls, 0);
  assert.deepEqual(missingJob.scheduled, []);

  const noDatabaseEnv = await testEnv();
  const noDatabaseConfig = loadConfig(noDatabaseEnv, noDatabaseEnv.ISSUER_URL!);
  const noDatabaseSubject = crypto.randomUUID();
  const noDatabaseHandle = await sealAccountDeletionStatus(
    noDatabaseSubject,
    OWNER_IDENTITY.email,
    noDatabaseConfig,
    nowSeconds(),
  );
  const noDatabaseScheduled: Promise<unknown>[] = [];
  const noDatabaseApp = createAittaDBWithStore(
    noDatabaseEnv,
    null,
    noDatabaseConfig,
    {
      waitUntil(promise) {
        noDatabaseScheduled.push(promise);
      },
    },
    { read: () => OWNER_IDENTITY },
  );
  const noDatabaseResponse = await fetchResponse(
    noDatabaseApp,
    statusRequest(noDatabaseHandle),
  );
  assert.equal(noDatabaseResponse.status, 503);
  assert.equal(noDatabaseResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(noDatabaseScheduled, []);

  const dependencyStore = new ObservedAccountDeletionStore();
  const dependencyUser = await dependencyStore.findOrCreateUser(
    OWNER_IDENTITY,
    nowSeconds(),
  );
  await dependencyStore.startAccountDeletionJob(
    dependencyUser.id,
    nowSeconds(),
  );
  const dependencyEnv = await testEnv();
  const dependencyConfig = loadConfig(dependencyEnv, dependencyEnv.ISSUER_URL!);
  const dependencyHandle = await sealAccountDeletionStatus(
    dependencyUser.id,
    dependencyUser.email,
    dependencyConfig,
    nowSeconds(),
  );
  const identityProvider: UpstreamIdentityProvider = {
    read: () => OWNER_IDENTITY,
  };
  const withoutBucket = { ...dependencyEnv };
  delete withoutBucket.BUCKET;
  const missingBucketScheduled: Promise<unknown>[] = [];
  const missingBucketApp = createAittaDBWithStore(
    withoutBucket,
    dependencyStore,
    dependencyConfig,
    {
      waitUntil(promise) {
        missingBucketScheduled.push(promise);
      },
    },
    identityProvider,
  );
  dependencyStore.getJobCalls = 0;
  dependencyStore.claimCalls = 0;
  const missingBucketResponse = await fetchResponse(
    missingBucketApp,
    statusRequest(dependencyHandle),
  );
  assert.equal(missingBucketResponse.status, 503);
  assert.equal(missingBucketResponse.headers.get("cache-control"), "no-store");
  assert.equal(dependencyStore.getJobCalls, 1);
  assert.equal(dependencyStore.claimCalls, 0);
  assert.deepEqual(missingBucketScheduled, []);

  const missingContextApp = createAittaDBWithStore(
    dependencyEnv,
    dependencyStore,
    dependencyConfig,
    undefined,
    identityProvider,
  );
  dependencyStore.getJobCalls = 0;
  dependencyStore.claimCalls = 0;
  const missingContextResponse = await fetchResponse(
    missingContextApp,
    statusRequest(dependencyHandle),
  );
  assert.equal(missingContextResponse.status, 503);
  assert.equal(missingContextResponse.headers.get("cache-control"), "no-store");
  assert.equal(dependencyStore.getJobCalls, 1);
  assert.equal(dependencyStore.claimCalls, 0);
});

test("POST never creates or updates identity and background failure cannot replace 202", async () => {
  const fixture = await createFixture({ rejectCoordinator: true });
  const controls = await sessionControls(fixture);
  const findCalls = fixture.store.findOrCreateCalls;
  const before = await fixture.store.getUser(fixture.user.id);
  fixture.store.startCalls = 0;
  fixture.store.userByEmailCalls = 0;
  fixture.scheduled.length = 0;

  const response = await postDeletion(fixture, controls);
  assert.equal(response.status, 202);
  assert.equal(fixture.store.findOrCreateCalls, findCalls);
  assert.equal(fixture.store.userByEmailCalls, 1);
  assert.equal(fixture.store.startCalls, 1);
  assert.equal(fixture.scheduled.length, 1);
  await drainScheduled(fixture);
  assert.equal(fixture.store.claimCalls, 1);
  assert.deepEqual(await fixture.store.getUser(fixture.user.id), before);
  assert.deepEqual(fixture.store.audits, []);
});

test("caught coordinator phase failure emits one fixed private event", async () => {
  const fixture = await createFixture({
    coordinatorFailurePhase: "credentials",
  });
  const controls = await sessionControls(fixture);
  const logged: unknown[][] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => logged.push(values);
  try {
    const response = await postDeletion(fixture, controls);
    assert.equal(response.status, 202);
    assert.equal(fixture.scheduled.length, 1);
    await drainScheduled(fixture);
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(logged, [
    [accountDeletionCoordinatorFailureTelemetry("credentials")],
  ]);
  const serialized = JSON.stringify(logged);
  for (const privateValue of [
    fixture.user.id,
    fixture.user.email,
    controls.confirmationToken,
    controls.csrf,
    "synthetic_phase_failure_with_private_context",
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("credential purge failure emits one fixed private subphase event", async () => {
  const fixture = await createFixture({
    coordinatorCredentialFailurePhase: "device-grants",
  });
  const controls = await sessionControls(fixture);
  const logged: unknown[][] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => logged.push(values);
  try {
    const response = await postDeletion(fixture, controls);
    assert.equal(response.status, 202);
    await drainScheduled(fixture);
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(logged, [
    [accountCredentialPurgeFailureTelemetry("device-grants")],
    [accountDeletionCoordinatorFailureTelemetry("credentials")],
  ]);
  const serialized = JSON.stringify(logged);
  for (const privateValue of [
    fixture.user.id,
    fixture.user.email,
    controls.confirmationToken,
    controls.csrf,
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("durably deferred coordinator pass emits one fixed private event", async () => {
  const fixture = await createFixture({
    coordinatorDeferredPhase: "credentials",
  });
  const controls = await sessionControls(fixture);
  const logged: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => logged.push(values);
  try {
    const response = await postDeletion(fixture, controls);
    assert.equal(response.status, 202);
    assert.equal(fixture.scheduled.length, 1);
    await drainScheduled(fixture);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(logged, [
    [accountDeletionCoordinatorDeferredTelemetry("credentials")],
  ]);
  const serialized = JSON.stringify(logged);
  for (const privateValue of [
    fixture.user.id,
    fixture.user.email,
    controls.confirmationToken,
    controls.csrf,
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("stale cross-account and invalid confirmation tokens fail without starting", async () => {
  const staleFixture = await createFixture();
  const staleControls = await sessionControls(staleFixture);
  const other = await staleFixture.store.findOrCreateUser(
    OTHER_IDENTITY,
    nowSeconds(),
  );
  staleFixture.identity.current = OTHER_IDENTITY;
  staleFixture.store.startCalls = 0;
  const stale = await postDeletion(staleFixture, staleControls);
  assertGenericRejection(stale);
  assert.equal(staleFixture.store.startCalls, 0);
  assert.equal(await staleFixture.store.getAccountDeletionJob(other.id), null);
  assert.equal(
    await staleFixture.store.getAccountDeletionJob(staleFixture.user.id),
    null,
  );

  const fixture = await createFixture();
  const controls = await sessionControls(fixture);
  const current = nowSeconds();
  const expired = await sealAccountDeletionConfirmation(
    fixture.user.id,
    fixture.user.email,
    fixture.config,
    current - ACCOUNT_DELETION_CONFIRMATION_TTL_SECONDS,
  );
  const wrongIssuer = await sealAccountDeletionConfirmation(
    fixture.user.id,
    fixture.user.email,
    { ...fixture.config, issuerUrl: "https://wrong-issuer.example.test" },
    current,
  );
  const wrongKeyConfig = loadConfig(await testEnv(), ISSUER);
  const wrongKey = await sealAccountDeletionConfirmation(
    fixture.user.id,
    fixture.user.email,
    wrongKeyConfig,
    current,
  );
  const tampered = `${controls.confirmationToken.slice(0, -1)}${
    controls.confirmationToken.endsWith("A") ? "B" : "A"
  }`;
  fixture.store.startCalls = 0;
  for (const confirmationToken of [tampered, expired, wrongIssuer, wrongKey]) {
    const rejected = await postDeletion(fixture, {
      ...controls,
      confirmationToken,
    });
    assertGenericRejection(rejected);
  }
  assert.equal(fixture.store.startCalls, 0);
  assert.equal(
    await fixture.store.getAccountDeletionJob(fixture.user.id),
    null,
  );
  await drainScheduled(staleFixture);
  await drainScheduled(fixture);
});

test("missing identity or user, administrators, and replay fail generically", async () => {
  const missingIdentityFixture = await createFixture();
  const controls = await sessionControls(missingIdentityFixture);
  missingIdentityFixture.identity.current = null;
  missingIdentityFixture.store.userByEmailCalls = 0;
  const missingIdentity = await postDeletion(missingIdentityFixture, controls);
  assertGenericRejection(missingIdentity);
  assert.equal(missingIdentityFixture.store.userByEmailCalls, 0);

  const missingUserFixture = await createFixture();
  const missingUserControls = await sessionControls(missingUserFixture);
  missingUserFixture.identity.current = {
    email: "missing-user@example.test",
    fullName: null,
    displayName: "missing-user@example.test",
  };
  const missingUser = await postDeletion(
    missingUserFixture,
    missingUserControls,
  );
  assertGenericRejection(missingUser);
  assert.equal(missingUserFixture.store.startCalls, 0);

  const adminFixture = await createFixture({ admin: true });
  const adminCsrf = "admin_deletion_csrf_value_00001";
  const adminToken = await sealAccountDeletionConfirmation(
    adminFixture.user.id,
    adminFixture.user.email,
    adminFixture.config,
    nowSeconds(),
  );
  const admin = await postDeletion(adminFixture, {
    action: emptyAction(),
    confirmationField: emptyField(),
    confirmationToken: adminToken,
    csrf: adminCsrf,
    cookie: `aittadb_csrf=${adminCsrf}`,
  });
  assertGenericRejection(admin);
  assert.equal(adminFixture.store.startCalls, 0);

  const replayFixture = await createFixture({ rejectCoordinator: true });
  const replayControls = await sessionControls(replayFixture);
  replayFixture.store.startCalls = 0;
  assert.equal((await postDeletion(replayFixture, replayControls)).status, 202);
  const job = await replayFixture.store.getAccountDeletionJob(
    replayFixture.user.id,
  );
  const replay = await postDeletion(replayFixture, replayControls);
  assertGenericRejection(replay);
  assert.equal(replayFixture.store.startCalls, 2);
  assert.deepEqual(
    await replayFixture.store.getAccountDeletionJob(replayFixture.user.id),
    job,
  );
  assert.equal(replayFixture.scheduled.length, 1);
  await drainScheduled(replayFixture);
  await drainScheduled(missingIdentityFixture);
  await drainScheduled(missingUserFixture);
  await drainScheduled(adminFixture);
});

test("origin, CSRF, body, malformed-input, and endpoint rate bounds fail closed", async () => {
  const originFixture = await createFixture();
  const originCounter = { pulls: 0 };
  const originResponse = await fetchResponse(
    originFixture.app,
    countedRequest(originCounter),
  );
  assert.equal(originResponse.status, 403);
  assert.equal(originCounter.pulls, 0);
  assert.deepEqual(originFixture.store.rateKeys, []);
  assert.equal(originFixture.store.userByEmailCalls, 0);

  const overflowFixture = await createFixture();
  const overflow = await fetchResponse(
    overflowFixture.app,
    new Request(`${REQUEST_ORIGIN}/account/deletion`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        origin: ISSUER,
      },
      body: `confirmation=${"x".repeat(1100)}`,
    }),
  );
  assert.equal(overflow.status, 413);
  assert.deepEqual(overflowFixture.store.rateKeys, []);
  assert.equal(overflowFixture.store.userByEmailCalls, 0);

  const inputFixture = await createFixture();
  const controls = await sessionControls(inputFixture);
  inputFixture.store.startCalls = 0;
  const badCsrf = await postDeletion(inputFixture, {
    ...controls,
    csrf: "wrong_csrf_value_00000000000000",
  });
  assertGenericRejection(badCsrf);
  const malformed = await fetchResponse(
    inputFixture.app,
    deletionRequest("{", controls.cookie, "application/json"),
  );
  assertGenericRejection(malformed);
  const unsupported = await fetchResponse(
    inputFixture.app,
    deletionRequest("plain", controls.cookie, "text/plain"),
  );
  assert.equal(unsupported.status, 415);
  assert.equal(inputFixture.store.startCalls, 0);

  const perIpFixture = await createFixture();
  perIpFixture.identity.current = null;
  const perIpStatuses: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    perIpStatuses.push(
      (
        await fetchResponse(
          perIpFixture.app,
          deletionRequest(
            form({
              csrf_token: "rate_limit_csrf_value_0000001",
              confirmation_token: "invalid",
              confirmation: ACCOUNT_DELETION_CONFIRMATION_PHRASE,
            }),
            "aittadb_csrf=rate_limit_csrf_value_0000001",
          ),
        )
      ).status,
    );
  }
  assert.deepEqual(perIpStatuses, [400, 400, 400, 400, 400, 429]);
  assertRateKeysArePseudonymous(perIpFixture.store);

  const globalFixture = await createFixture();
  globalFixture.identity.current = null;
  let globalResponse: Response | null = null;
  for (let index = 0; index < 51; index += 1) {
    globalResponse = await fetchResponse(
      globalFixture.app,
      deletionRequest(
        form({
          csrf_token: "global_rate_csrf_value_000001",
          confirmation_token: "invalid",
          confirmation: ACCOUNT_DELETION_CONFIRMATION_PHRASE,
        }),
        "aittadb_csrf=global_rate_csrf_value_000001",
        "application/x-www-form-urlencoded",
        { "cf-connecting-ip": `192.0.2.${index + 1}` },
      ),
    );
  }
  assert.equal(globalResponse?.status, 429);
  assert.equal(
    globalFixture.store.counters.get("account-deletion:global")?.count,
    51,
  );
  assertRateKeysArePseudonymous(globalFixture.store);
  await drainScheduled(originFixture);
  await drainScheduled(overflowFixture);
  await drainScheduled(inputFixture);
  await drainScheduled(perIpFixture);
  await drainScheduled(globalFixture);
});

interface MutableIdentity {
  current: UpstreamIdentity | null;
}

interface TestFixture {
  app: AittaDBApp;
  config: AppConfig;
  env: RuntimeEnv;
  identity: MutableIdentity;
  scheduled: Promise<unknown>[];
  bucket: ObservedR2Bucket;
  store: ObservedAccountDeletionStore;
  user: LocalUser;
}

interface HypermediaFieldValue {
  name: string;
  value?: unknown;
  min_length?: number;
  max_length?: number;
}

interface HypermediaActionValue {
  name: string;
  method: string;
  href: string;
  type?: string;
  fields: HypermediaFieldValue[];
}

interface SessionDocumentValue {
  actions: HypermediaActionValue[];
}

interface SessionControls {
  action: HypermediaActionValue;
  confirmationField: HypermediaFieldValue;
  confirmationToken: string;
  csrf: string;
  cookie: string;
}

async function createFixture(
  options: {
    admin?: boolean;
    rejectCoordinator?: boolean;
    coordinatorFailurePhase?: AccountDeletionCoordinatorFailurePhase;
    coordinatorDeferredPhase?: AccountDeletionCoordinatorDeferredPhase;
    coordinatorCredentialFailurePhase?: AccountCredentialPurgeFailurePhase;
  } = {},
): Promise<TestFixture> {
  const store = new ObservedAccountDeletionStore();
  const bucket = new ObservedR2Bucket();
  const user = await store.findOrCreateUser(OWNER_IDENTITY, nowSeconds());
  store.rejectCoordinator = options.rejectCoordinator ?? false;
  store.coordinatorFailurePhase = options.coordinatorFailurePhase ?? null;
  store.coordinatorDeferredPhase = options.coordinatorDeferredPhase ?? null;
  store.coordinatorCredentialFailurePhase =
    options.coordinatorCredentialFailurePhase ?? null;
  const env = await testEnv({
    BUCKET: bucket,
    ...(options.admin ? { ADMIN_SUBJECTS: user.id } : {}),
  });
  const config = loadConfig(env, env.ISSUER_URL!);
  const identity: MutableIdentity = { current: OWNER_IDENTITY };
  const identityProvider: UpstreamIdentityProvider = {
    read: () => identity.current,
  };
  const scheduled: Promise<unknown>[] = [];
  const app = createAittaDBWithStore(
    env,
    store,
    config,
    {
      waitUntil(promise) {
        scheduled.push(promise);
        void promise.catch(() => undefined);
      },
    },
    identityProvider,
  );
  return { app, bucket, config, env, identity, scheduled, store, user };
}

async function sessionDocument(
  fixture: TestFixture,
): Promise<SessionDocumentValue> {
  const response = await fetchResponse(
    fixture.app,
    new Request(`${REQUEST_ORIGIN}/session`, {
      headers: {
        accept: "application/vnd.aittadb+json; version=0.1",
      },
    }),
  );
  assert.equal(response.status, 200);
  return (await response.json()) as SessionDocumentValue;
}

async function sessionControls(fixture: TestFixture): Promise<SessionControls> {
  const response = await fetchResponse(
    fixture.app,
    new Request(`${REQUEST_ORIGIN}/session`, {
      headers: {
        accept: "application/vnd.aittadb+json; version=0.1",
      },
    }),
  );
  assert.equal(response.status, 200);
  const document = (await response.json()) as SessionDocumentValue;
  const action = document.actions.find(
    (candidate) => candidate.name === "request-account-deletion",
  );
  assert.ok(action);
  const csrf = String(
    action.fields.find((field) => field.name === "csrf_token")?.value ?? "",
  );
  const confirmationToken = String(
    action.fields.find((field) => field.name === "confirmation_token")?.value ??
      "",
  );
  const confirmationField = action.fields.find(
    (field) => field.name === "confirmation",
  );
  assert.ok(confirmationField);
  const cookie = `aittadb_csrf=${cookieValue(response, "aittadb_csrf")}`;
  assert.equal(cookie, `aittadb_csrf=${csrf}`);
  await drainScheduled(fixture);
  return { action, confirmationField, confirmationToken, csrf, cookie };
}

async function postDeletion(
  fixture: TestFixture,
  controls: SessionControls,
  options: { accept?: string; json?: boolean } = {},
): Promise<Response> {
  const values = {
    csrf_token: controls.csrf,
    confirmation_token: controls.confirmationToken,
    confirmation: ACCOUNT_DELETION_CONFIRMATION_PHRASE,
  };
  return fetchResponse(
    fixture.app,
    deletionRequest(
      options.json ? JSON.stringify(values) : form(values),
      controls.cookie,
      options.json ? "application/json" : "application/x-www-form-urlencoded",
      { accept: options.accept ?? "application/json" },
    ),
  );
}

function deletionRequest(
  body: BodyInit,
  cookie: string,
  contentType = "application/x-www-form-urlencoded",
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(`${REQUEST_ORIGIN}/account/deletion`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": contentType,
      cookie,
      origin: ISSUER,
      ...extraHeaders,
    },
    body,
  });
}

function statusRequest(
  handle: string | null,
  options: { accept?: string; method?: string } = {},
): Request {
  const headers = new Headers({ accept: options.accept ?? "application/json" });
  if (handle) {
    headers.set("cookie", `${ACCOUNT_DELETION_STATUS_COOKIE_NAME}=${handle}`);
  }
  return new Request(`${REQUEST_ORIGIN}/account/deletion`, {
    method: options.method ?? "GET",
    headers,
  });
}

function countedRequest(counter: { pulls: number }): Request {
  let sent = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        counter.pulls += 1;
        if (sent) {
          controller.close();
          return;
        }
        sent = true;
        controller.enqueue(new TextEncoder().encode("confirmation=invalid"));
      },
    },
    { highWaterMark: 0 },
  );
  return new Request(`${REQUEST_ORIGIN}/account/deletion`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

async function fetchResponse(
  app: AittaDBApp,
  request: Request,
): Promise<Response> {
  const response = await app.fetch(request);
  assert.ok(response);
  return response;
}

async function drainScheduled(fixture: TestFixture): Promise<void> {
  const scheduled = fixture.scheduled.splice(0);
  await Promise.allSettled(scheduled);
}

function assertGenericRejection(response: Response): void {
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

function assertGenericStatusRejection(response: Response): void {
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

function assertSafeAcceptedEvidence(
  body: string,
  user: LocalUser,
  controls: SessionControls,
  store: ObservedAccountDeletionStore,
): void {
  for (const forbidden of [
    user.id,
    user.email,
    controls.csrf,
    controls.confirmationToken,
  ]) {
    assert.doesNotMatch(body, new RegExp(forbidden));
  }
  assert.doesNotMatch(
    body,
    /subject|attempt|created_at|updated_at|completed_at|client_id|storage_(?:key|count|bytes)|credential_/i,
  );
  assert.deepEqual(store.audits, []);
}

function assertSafeStatusEvidence(body: string, user: LocalUser): void {
  for (const forbidden of [user.id, user.email, "123450", "123455", "123456"]) {
    assert.doesNotMatch(body, new RegExp(forbidden));
  }
  assert.doesNotMatch(
    body,
    /subject|attempt|created_at|updated_at|completed_at|available_at|client_id|storage_(?:key|count|bytes)|credential_/i,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertRateKeysArePseudonymous(
  store: ObservedAccountDeletionStore,
): void {
  const keys = [...store.counters.keys()];
  assert.ok(keys.includes("account-deletion:global"));
  const perIpKeys = keys.filter((key) =>
    key.startsWith("account-deletion:ip:"),
  );
  assert.ok(perIpKeys.length > 0);
  for (const key of perIpKeys) {
    assert.match(key, /^account-deletion:ip:[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(key, /192\.0\.2\.|example\.test/);
    assert.ok(key.length < 80);
  }
}

function emptyAction(): HypermediaActionValue {
  return { name: "", method: "POST", href: "", fields: [] };
}

function emptyField(): HypermediaFieldValue {
  return { name: "confirmation" };
}

test("confirmation token used by the handler opens only for its exact binding", async () => {
  const fixture = await createFixture();
  const controls = await sessionControls(fixture);
  assert.equal(
    await openAccountDeletionConfirmation(
      controls.confirmationToken,
      fixture.user.id,
      fixture.user.email,
      fixture.config,
      nowSeconds(),
    ),
    true,
  );
  await drainScheduled(fixture);
});
