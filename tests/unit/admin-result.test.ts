import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_RESULT_COOKIE_NAME,
  ADMIN_RESULT_TTL_SECONDS,
  adminResultCookie,
  clearAdminResultCookie,
  createAdminSubmissionToken,
  openAdminResult,
  sealAdminResult,
} from "../../src/admin-result";
import { loadConfig } from "../../src/config";
import { randomToken } from "../../src/crypto";
import { testEnv } from "../helpers";

test("admin result state is encrypted, subject-bound, expiring, and tamper-evident", async () => {
  const env = await testEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const subject = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const submissionToken = createAdminSubmissionToken();
  const secret = randomToken(32);
  const sealed = await sealAdminResult(
    submissionToken,
    { operation: "create", clientId, secret },
    subject,
    config,
    100,
  );

  assert.match(sealed, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(sealed, new RegExp(submissionToken));
  assert.doesNotMatch(sealed, new RegExp(clientId));
  assert.doesNotMatch(sealed, new RegExp(secret));
  assert.deepEqual(await openAdminResult(sealed, subject, config, 101), {
    submissionToken,
    result: { operation: "create", clientId, secret },
  });
  assert.equal(
    await openAdminResult(sealed, crypto.randomUUID(), config, 101),
    null,
  );
  assert.equal(
    await openAdminResult(
      `${sealed.slice(0, -1)}${sealed.endsWith("A") ? "B" : "A"}`,
      subject,
      config,
      101,
    ),
    null,
  );
  assert.equal(
    await openAdminResult(
      sealed,
      subject,
      config,
      100 + ADMIN_RESULT_TTL_SECONDS,
    ),
    null,
  );

  const rotatedConfig = loadConfig(await testEnv(), env.ISSUER_URL!);
  assert.equal(
    await openAdminResult(sealed, subject, rotatedConfig, 101),
    null,
  );
});

test("admin result cookie is short-lived, HttpOnly, secure, and clearable", () => {
  const cookie = adminResultCookie("v1.iv.ciphertext");
  assert.match(cookie, new RegExp(`^${ADMIN_RESULT_COOKIE_NAME}=`));
  assert.match(cookie, /Path=\/admin\/clients/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, new RegExp(`Max-Age=${ADMIN_RESULT_TTL_SECONDS}`));
  assert.match(clearAdminResultCookie(), /Max-Age=0/);
});
