import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_DELETION_CONFIRMATION_PHRASE,
  ACCOUNT_DELETION_CONFIRMATION_TTL_SECONDS,
  ACCOUNT_DELETION_REQUEST_MAX_BYTES,
  openAccountDeletionConfirmation,
  sealAccountDeletionConfirmation,
} from "../../src/account-deletion-request";
import { loadConfig } from "../../src/config";
import { testEnv } from "../helpers";

test("account deletion confirmation is encrypted, identity-bound, and expiring", async () => {
  const env = await testEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const subject = crypto.randomUUID();
  const email = "account-owner@example.test";
  const sealed = await sealAccountDeletionConfirmation(
    subject,
    email,
    config,
    100,
  );

  assert.match(sealed, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(sealed, new RegExp(subject));
  assert.doesNotMatch(sealed, new RegExp(email));
  assert.equal(
    await openAccountDeletionConfirmation(sealed, subject, email, config, 101),
    true,
  );
  assert.equal(
    await openAccountDeletionConfirmation(
      sealed,
      crypto.randomUUID(),
      email,
      config,
      101,
    ),
    false,
  );
  assert.equal(
    await openAccountDeletionConfirmation(
      sealed,
      subject,
      "other-owner@example.test",
      config,
      101,
    ),
    false,
  );
  assert.equal(
    await openAccountDeletionConfirmation(
      sealed,
      subject,
      email,
      { ...config, issuerUrl: "https://other-issuer.example.test" },
      101,
    ),
    false,
  );
  assert.equal(
    await openAccountDeletionConfirmation(
      sealed,
      subject,
      email,
      loadConfig(await testEnv(), env.ISSUER_URL!),
      101,
    ),
    false,
  );
  assert.equal(
    await openAccountDeletionConfirmation(
      sealed,
      subject,
      email,
      config,
      100 + ACCOUNT_DELETION_CONFIRMATION_TTL_SECONDS,
    ),
    false,
  );
});

test("account deletion confirmation rejects tampering and malformed values", async () => {
  const env = await testEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const subject = crypto.randomUUID();
  const email = "account-owner@example.test";
  const sealed = await sealAccountDeletionConfirmation(
    subject,
    email,
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
      await openAccountDeletionConfirmation(value, subject, email, config, 501),
      false,
    );
  }
  assert.equal(ACCOUNT_DELETION_CONFIRMATION_PHRASE, "delete my account");
  assert.equal(ACCOUNT_DELETION_REQUEST_MAX_BYTES, 1024);
});
