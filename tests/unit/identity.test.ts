import test from "node:test";
import assert from "node:assert/strict";
import { readSitesIdentity, safeRelativeReturnPath } from "../../src/identity";
import { requireSameOrigin } from "../../src/http";

test("parses Sites identity headers with percent-encoded UTF-8 name", () => {
  const request = new Request("https://broker.example.test/device", {
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
  const request = new Request("https://broker.example.test/device", {
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
      new Request("https://broker.example.test/admin/clients", {
        method: "POST",
        headers: { origin: "null", "sec-fetch-site": "same-origin" },
      }),
    ),
    true,
  );
  assert.equal(
    requireSameOrigin(
      new Request("https://broker.example.test/admin/clients", {
        method: "POST",
        headers: { origin: "null", "sec-fetch-site": "cross-site" },
      }),
    ),
    false,
  );
});
