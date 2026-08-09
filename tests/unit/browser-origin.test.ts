import test from "node:test";
import assert from "node:assert/strict";
import { csrfTokenMatches, requireSameOrigin } from "../../src/http";

const canonicalOrigin = "https://aittadb.example.test";
const dispatchUrl = "https://internal.chatgpt.site/storage/files";

interface OriginCase {
  readonly name: string;
  readonly url?: string;
  readonly headers: Record<string, string>;
}

function requestFor(fixture: OriginCase): Request {
  return new Request(fixture.url ?? dispatchUrl, {
    method: "POST",
    headers: fixture.headers,
  });
}

test("browser origin classifier accepts canonical and Sites dispatch signals", () => {
  const fixtures: readonly OriginCase[] = [
    {
      name: "canonical issuer request",
      url: `${canonicalOrigin}/storage/files`,
      headers: { origin: canonicalOrigin },
    },
    {
      name: "canonical issuer behind the Sites dispatch URL",
      headers: { origin: canonicalOrigin },
    },
    {
      name: "opaque Sites dispatch with exact same-origin fetch metadata",
      headers: { origin: "null", "sec-fetch-site": "same-origin" },
    },
  ];

  for (const fixture of fixtures) {
    assert.equal(
      requireSameOrigin(requestFor(fixture), canonicalOrigin),
      true,
      fixture.name,
    );
  }
});

test("browser origin classifier rejects absent, malformed, foreign, and unauthorized opaque signals", () => {
  const fixtures: readonly OriginCase[] = [
    { name: "missing Origin", headers: {} },
    { name: "malformed Origin", headers: { origin: "not-an-origin" } },
    {
      name: "Origin containing a path",
      headers: { origin: `${canonicalOrigin}/storage/files` },
    },
    {
      name: "multiple serialized origins",
      headers: { origin: `${canonicalOrigin} https://attacker.example` },
    },
    {
      name: "foreign origin",
      headers: { origin: "https://attacker.example" },
    },
    {
      name: "canonical lookalike origin",
      headers: { origin: "https://aittadb.example.test.attacker.example" },
    },
    {
      name: "opaque cross-site request",
      headers: { origin: "null", "sec-fetch-site": "cross-site" },
    },
    {
      name: "opaque same-site request",
      headers: { origin: "null", "sec-fetch-site": "same-site" },
    },
    {
      name: "opaque request without fetch metadata",
      headers: { origin: "null" },
    },
  ];

  for (const fixture of fixtures) {
    assert.equal(
      requireSameOrigin(requestFor(fixture), canonicalOrigin),
      false,
      fixture.name,
    );
  }
});

test("browser origin classification and CSRF validation are independent", () => {
  const csrf = "A".repeat(32);
  const validOriginWithoutCsrf = new Request(
    `${canonicalOrigin}/storage/files`,
    {
      method: "POST",
      headers: { origin: canonicalOrigin },
    },
  );
  assert.equal(
    requireSameOrigin(validOriginWithoutCsrf, canonicalOrigin),
    true,
  );
  assert.equal(csrfTokenMatches(validOriginWithoutCsrf, csrf), false);

  const invalidOriginWithValidCsrf = new Request(
    `${canonicalOrigin}/storage/files`,
    {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        cookie: `aittadb_csrf=${csrf}`,
      },
    },
  );
  assert.equal(
    requireSameOrigin(invalidOriginWithValidCsrf, canonicalOrigin),
    false,
  );
  assert.equal(csrfTokenMatches(invalidOriginWithValidCsrf, csrf), true);
});
