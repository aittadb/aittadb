import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { pageDocument, privacyPolicyPage } from "../../src/pages";
import { buildPrivacyPolicy, resolvePrivacyContact } from "../../src/privacy";
import { MemoryAuthStore } from "../../src/store/memory";
import { nowSeconds } from "../../src/crypto";
import { testEnv } from "../helpers";

test("explicit privacy configuration needs no user lookup and renders escaped accessible HTML", async () => {
  const env = await testEnv({
    PRIVACY_CONTROLLER_NAME:
      'Aitta <script>alert("controller")</script> Services',
    PRIVACY_CONTROLLER_IDENTIFIER: "operator-123",
    PRIVACY_CONTACT_NAME: 'Privacy <script>alert("contact")</script> Contact',
    PRIVACY_CONTACT_EMAIL: "privacy@example.test",
    PRIVACY_CONTACT_PHONE: "+358 10 000 0000",
    PRIVACY_CONTACT_ADDRESS:
      'Street <script>alert("address")</script>, Helsinki',
  });
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MemoryAuthStore();
  const originalGetUser = store.getUser.bind(store);
  const lookups: string[] = [];
  store.getUser = async (id) => {
    lookups.push(id);
    return originalGetUser(id);
  };

  const contact = await resolvePrivacyContact(config, store);
  assert.ok(contact);
  assert.deepEqual(lookups, []);
  const policy = buildPrivacyPolicy(config, contact);
  const html = privacyPolicyPage(policy);

  assert.equal(policy.deployment, "https://aittadb.example.test");
  assert.equal(policy.controller.email, "privacy@example.test");
  assert.match(html, /^<html lang="en">/);
  assert.match(html, /<h1>Privacy Policy<\/h1>/);
  assert.match(html, /aria-label="Privacy controller and contact"/);
  assert.match(html, /aria-labelledby="privacy-scope"/);
  assert.match(html, /href="mailto:privacy@example\.test"/);
  assert.match(
    html,
    /Aitta &lt;script&gt;alert\(&quot;controller&quot;\)&lt;\/script&gt; Services/,
  );
  assert.match(
    html,
    /Privacy &lt;script&gt;alert\(&quot;contact&quot;\)&lt;\/script&gt; Contact/,
  );
  assert.doesNotMatch(html, /<script>/i);
  assert.match(
    html,
    /<nav class="footer-links" aria-label="Project information"><a href="\/privacy">Privacy<\/a>/,
  );
});

test("privacy policy omits optional controller and contact values that are unset", async () => {
  const env = await testEnv({
    PRIVACY_CONTROLLER_NAME: "AittaDB Test Operator",
    PRIVACY_CONTACT_EMAIL: "privacy@example.test",
  });
  const config = loadConfig(env, env.ISSUER_URL!);
  const contact = await resolvePrivacyContact(config, null);
  assert.ok(contact);

  const policy = buildPrivacyPolicy(config, contact);
  assert.deepEqual(policy.controller, {
    name: "AittaDB Test Operator",
    email: "privacy@example.test",
  });
  const html = privacyPolicyPage(policy);
  assert.doesNotMatch(html, /Controller identifier/);
  assert.doesNotMatch(html, /Privacy contact/);
  assert.doesNotMatch(html, /<span>Phone<\/span>/);
  assert.doesNotMatch(html, /<span>Postal address<\/span>/);
});

test("privacy contact fallback resolves only the first administrator by UUID", async () => {
  const store = new MemoryAuthStore();
  const now = nowSeconds();
  const first = await store.findOrCreateUser(
    {
      email: "first-admin@example.test",
      fullName: "First Administrator",
      displayName: "First Administrator",
    },
    now,
  );
  const second = await store.findOrCreateUser(
    {
      email: "second-admin@example.test",
      fullName: "Second Administrator",
      displayName: "Second Administrator",
    },
    now,
  );
  const env = await testEnv({
    ADMIN_SUBJECTS: `${first.id},${second.id}`,
  });
  const config = loadConfig(env, env.ISSUER_URL!);
  const originalGetUser = store.getUser.bind(store);
  const lookups: string[] = [];
  store.getUser = async (id) => {
    lookups.push(id);
    return originalGetUser(id);
  };

  const contact = await resolvePrivacyContact(config, store);
  assert.deepEqual(lookups, [first.id]);
  assert.deepEqual(contact, {
    controllerName: "First Administrator",
    contactName: "First Administrator",
    email: "first-admin@example.test",
  });

  const serialized = JSON.stringify(buildPrivacyPolicy(config, contact!));
  assert.equal(serialized.includes(first.id), false);
  assert.equal(serialized.includes(second.id), false);
  assert.equal(serialized.includes(second.email), false);
  assert.equal(serialized.includes(String(config.jwtPrivateJwk.d)), false);
  assert.equal(serialized.includes("ADMIN_SUBJECTS"), false);
});

test("invalid explicit privacy values fail closed instead of using administrator fallback", async () => {
  const subject = crypto.randomUUID();
  const malformedEnvironments = [
    {
      PRIVACY_CONTROLLER_NAME: "AittaDB Operator",
      PRIVACY_CONTACT_EMAIL: "not-an-email",
    },
    {
      PRIVACY_CONTROLLER_NAME: "AittaDB\u0000Operator",
      PRIVACY_CONTACT_EMAIL: "privacy@example.test",
    },
  ];

  for (const malformed of malformedEnvironments) {
    const env = await testEnv({ ADMIN_SUBJECTS: subject, ...malformed });
    const config = loadConfig(env, env.ISSUER_URL!);
    const store = new MemoryAuthStore();
    let lookups = 0;
    store.getUser = async () => {
      lookups += 1;
      throw new Error("invalid configuration must not consult fallback");
    };

    assert.equal(config.privacy.valid, false);
    assert.equal(await resolvePrivacyContact(config, store), null);
    assert.equal(lookups, 0);
  }
});

test("privacy fallback fails closed when its store or first administrator is unavailable", async () => {
  const subject = crypto.randomUUID();
  const env = await testEnv({ ADMIN_SUBJECTS: subject });
  const config = loadConfig(env, env.ISSUER_URL!);

  assert.equal(await resolvePrivacyContact(config, null), null);

  const store = new MemoryAuthStore();
  const lookups: string[] = [];
  store.getUser = async (id) => {
    lookups.push(id);
    return null;
  };
  assert.equal(await resolvePrivacyContact(config, store), null);
  assert.deepEqual(lookups, [subject]);
});

test("the shared HTML document footer always advertises the privacy resource", () => {
  const html = pageDocument({
    title: "Shared page",
    heading: "Shared page",
    body: "<p>Shared content</p>",
  });

  assert.match(html, /<footer class="page-footer">/);
  assert.match(html, /aria-label="Project information"/);
  assert.match(html, /<a href="\/privacy">Privacy<\/a>/);
});
