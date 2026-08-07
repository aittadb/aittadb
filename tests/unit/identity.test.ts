import test from "node:test";
import assert from "node:assert/strict";
import { readSitesIdentity, safeRelativeReturnPath } from "../../src/identity";
import { cors, requireSameOrigin } from "../../src/http";

test("parses Sites identity headers with percent-encoded UTF-8 name", () => {
  const request = new Request("https://aittadb.example.test/device", {
    headers: {
      "oai-authenticated-user-email": "person@example.test",
      "oai-authenticated-user-full-name": "Ada%20Lovelace",
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    },
  });
  assert.deepEqual(readSitesIdentity(request, {}), {
    email: "person@example.test",
    fullName: "Ada Lovelace",
    displayName: "Ada Lovelace",
  });
});

test("falls back to email when full-name encoding is unsupported", () => {
  const request = new Request("https://aittadb.example.test/device", {
    headers: {
      "oai-authenticated-user-email": "person@example.test",
      "oai-authenticated-user-full-name": "Ada%20Lovelace",
      "oai-authenticated-user-full-name-encoding": "legacy",
    },
  });
  assert.equal(
    readSitesIdentity(request, {})?.displayName,
    "person@example.test",
  );
});

test("rejects unsafe return paths", () => {
  assert.equal(safeRelativeReturnPath("https://evil.example/"), "/");
  assert.equal(safeRelativeReturnPath("//evil.example/"), "/");
  assert.equal(safeRelativeReturnPath("/signin-with-chatgpt"), "/");
  assert.equal(safeRelativeReturnPath("/device?x=1"), "/device?x=1");
});

test("accepts null origin only with same-origin fetch metadata", () => {
  assert.equal(
    requireSameOrigin(
      new Request("https://aittadb.example.test/admin/clients", {
        method: "POST",
        headers: { origin: "null", "sec-fetch-site": "same-origin" },
      }),
    ),
    true,
  );
  assert.equal(
    requireSameOrigin(
      new Request("https://aittadb.example.test/admin/clients", {
        method: "POST",
        headers: { origin: "null", "sec-fetch-site": "cross-site" },
      }),
    ),
    false,
  );
});

test("accepts the configured public origin behind the Sites dispatch URL", () => {
  const canonicalRequest = new Request(
    "https://internal.chatgpt.site/userinfo",
    {
      method: "POST",
      headers: { origin: "https://aittadb.example.test" },
    },
  );
  assert.equal(
    requireSameOrigin(canonicalRequest, "https://aittadb.example.test"),
    true,
  );
  assert.ok(
    cors(canonicalRequest, [], "https://aittadb.example.test") instanceof
      Headers,
  );

  const sameSiteNullRequest = new Request(
    "https://internal.chatgpt.site/userinfo",
    {
      method: "POST",
      headers: { origin: "null", "sec-fetch-site": "same-origin" },
    },
  );
  assert.ok(
    cors(sameSiteNullRequest, [], "https://aittadb.example.test") instanceof
      Headers,
  );

  const foreignRequest = new Request("https://internal.chatgpt.site/userinfo", {
    method: "POST",
    headers: { origin: "https://attacker.example" },
  });
  const rejected = cors(foreignRequest, [], "https://aittadb.example.test");
  assert.ok(rejected instanceof Response);
  assert.equal(rejected.status, 403);
});
