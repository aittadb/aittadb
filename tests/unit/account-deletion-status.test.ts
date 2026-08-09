import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_DELETION_STATUS_COOKIE_NAME,
  ACCOUNT_DELETION_STATUS_TTL_SECONDS,
  accountDeletionPublicStatus,
  accountDeletionStatusCookie,
  openAccountDeletionStatus,
  readAccountDeletionStatusHandle,
  sealAccountDeletionStatus,
} from "../../src/account-deletion-status";
import {
  openAccountDeletionConfirmation,
  sealAccountDeletionConfirmation,
} from "../../src/account-deletion-request";
import { loadConfig } from "../../src/config";
import { testEnv } from "../helpers";

test("account deletion status handle is encrypted and purpose-bound", async () => {
  const env = await testEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const subject = crypto.randomUUID();
  const email = "deleted-owner@example.test";
  const sealed = await sealAccountDeletionStatus(subject, email, config, 100);

  assert.match(sealed, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(sealed, new RegExp(subject));
  assert.doesNotMatch(sealed, new RegExp(email));
  assert.deepEqual(
    await openAccountDeletionStatus(sealed, email, config, 101),
    { subject },
  );
  assert.equal(
    await openAccountDeletionStatus(
      sealed,
      "switched-owner@example.test",
      config,
      101,
    ),
    null,
  );
  assert.equal(
    await openAccountDeletionStatus(
      sealed,
      email,
      { ...config, issuerUrl: "https://wrong-issuer.example.test" },
      101,
    ),
    null,
  );
  assert.equal(
    await openAccountDeletionStatus(
      sealed,
      email,
      { ...config, jwtKeyId: "replacement-key" },
      101,
    ),
    null,
  );
  assert.equal(
    await openAccountDeletionStatus(
      sealed,
      email,
      loadConfig(await testEnv(), env.ISSUER_URL!),
      101,
    ),
    null,
  );
  assert.equal(
    await openAccountDeletionStatus(
      sealed,
      email,
      config,
      100 + ACCOUNT_DELETION_STATUS_TTL_SECONDS,
    ),
    null,
  );

  const confirmation = await sealAccountDeletionConfirmation(
    subject,
    email,
    config,
    100,
  );
  assert.equal(
    await openAccountDeletionStatus(confirmation, email, config, 101),
    null,
  );
  assert.equal(
    await openAccountDeletionConfirmation(sealed, subject, email, config, 101),
    false,
  );
});

test("account deletion status rejects malformed values and uses a scoped cookie", async () => {
  const env = await testEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const sealed = await sealAccountDeletionStatus(
    crypto.randomUUID(),
    "deleted-owner@example.test",
    config,
    500,
  );
  const tampered = `${sealed.slice(0, -1)}${sealed.endsWith("A") ? "B" : "A"}`;
  for (const value of [
    "",
    "v1.bad",
    "v2.iv.ciphertext",
    tampered,
    "x".repeat(513),
  ]) {
    assert.equal(
      await openAccountDeletionStatus(
        value,
        "deleted-owner@example.test",
        config,
        501,
      ),
      null,
    );
  }

  const cookie = accountDeletionStatusCookie(sealed);
  assert.equal(
    cookie,
    `${ACCOUNT_DELETION_STATUS_COOKIE_NAME}=${sealed}; Path=/account/deletion; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
  );
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.equal(
    readAccountDeletionStatusHandle(
      new Request("https://aittadb.example.test/account/deletion", {
        headers: { cookie: `${ACCOUNT_DELETION_STATUS_COOKIE_NAME}=${sealed}` },
      }),
    ),
    sealed,
  );
});

test("account deletion status maps only the four public states", () => {
  assert.equal(accountDeletionPublicStatus("pending"), "pending");
  assert.equal(accountDeletionPublicStatus("running"), "running");
  assert.equal(accountDeletionPublicStatus("retryable"), "retry");
  assert.equal(accountDeletionPublicStatus("completed"), "completed");
});
