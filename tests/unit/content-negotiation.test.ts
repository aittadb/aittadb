import assert from "node:assert/strict";
import test from "node:test";

import {
  HYPERMEDIA_MEDIA_TYPE,
  hypermediaNegotiationError,
  hypermediaVersionError,
  negotiateHypermediaRepresentation,
  parseAcceptHeader,
  prefersVendorHypermedia,
  requestedHypermediaVersion,
} from "../../src/hypermedia";
import {
  acceptsHtml,
  acceptsJson,
  hypermediaError,
  oauthError,
} from "../../src/http";

function withAccept(accept?: string): Request {
  return new Request("https://aittadb.example.test/health", {
    headers: accept === undefined ? undefined : { accept },
  });
}

test("parses media ranges, quoted parameters, quality, and exclusions", () => {
  const ranges = parseAcceptHeader(
    'application/vnd.aittadb+json; version="0.1"; q=0.750; ext="a,b", text/html; Q=0',
  );

  assert.equal(ranges.length, 2);
  assert.deepEqual(ranges[0], {
    type: "application",
    subtype: "vnd.aittadb+json",
    parameters: { version: "0.1" },
    quality: 0.75,
    order: 0,
  });
  assert.equal(ranges[1]?.quality, 0);
  assert.deepEqual(
    parseAcceptHeader("application/json;q=1.2, text/html;q=0.5").map(
      ({ type, subtype }) => `${type}/${subtype}`,
    ),
    ["text/html"],
  );
});

test("selects by effective quality, specificity, client order, and fallback", () => {
  const cases: Array<[string | undefined, string | null]> = [
    [undefined, "json"],
    ["*/*", "json"],
    ["application/*", "json"],
    ["text/*", "html"],
    ["text/html, */*;q=0.8", "html"],
    ["application/json, text/html", "json"],
    ["text/html, application/json", "html"],
    ["text/html;q=0.5, application/json;q=0.9", "json"],
    [
      "application/vnd.aittadb+json;version=0.1;q=0.8, application/json;q=0.9",
      "json",
    ],
    [
      "application/vnd.aittadb+json;version=0.1, application/json;q=0.9",
      "hypermedia",
    ],
    ["application/json;q=0, text/html;q=0.5", "html"],
    ["text/html;q=0, */*;q=0.8", "json"],
    ["application/problem+json", null],
    ["image/png", null],
  ];

  for (const [accept, expected] of cases) {
    assert.equal(
      negotiateHypermediaRepresentation(withAccept(accept)),
      expected,
      accept ?? "missing Accept",
    );
  }
});

test("allows a resource to prefer HTML only when the client is indifferent", () => {
  const select = (accept?: string) =>
    negotiateHypermediaRepresentation(withAccept(accept), "html");

  assert.equal(select(), "html");
  assert.equal(select("*/*"), "html");
  assert.equal(select("application/json"), "json");
  assert.equal(
    select("application/vnd.aittadb+json; version=0.1"),
    "hypermedia",
  );
  assert.equal(select("application/*"), "json");
  assert.equal(select("text/html;q=0, */*;q=0.8"), "json");
  assert.equal(select("image/png"), null);

  assert.equal(negotiateHypermediaRepresentation(withAccept("*/*")), "json");
});

test("uses supported fallbacks instead of rejecting an excluded or unsupported vendor range", () => {
  for (const accept of [
    "application/vnd.aittadb+json;version=9, application/json;q=0.5",
    "application/vnd.aittadb+json;version=9;q=0, application/json",
    "application/vnd.aittadb+json;q=0, application/json",
  ]) {
    const request = withAccept(accept);
    assert.equal(negotiateHypermediaRepresentation(request), "json");
    assert.equal(hypermediaVersionError(request), null);
    assert.equal(prefersVendorHypermedia(request), false);
  }

  const supported = withAccept('application/vnd.aittadb+json;version="0.1"');
  assert.deepEqual(requestedHypermediaVersion(supported), {
    requested: true,
    version: "0.1",
  });
  assert.equal(prefersVendorHypermedia(supported), true);
});

test("reports version-specific and generic negotiation failures", () => {
  const unsupported = withAccept("application/vnd.aittadb+json;version=9");
  assert.match(
    hypermediaVersionError(unsupported) ?? "",
    /Unsupported AittaDB API version: 9/,
  );
  assert.match(
    hypermediaNegotiationError(unsupported) ?? "",
    /Unsupported AittaDB API version: 9/,
  );

  const missing = withAccept(HYPERMEDIA_MEDIA_TYPE);
  assert.match(hypermediaVersionError(missing) ?? "", /requires version=0\.1/);

  const unrelated = withAccept("image/png");
  assert.equal(hypermediaVersionError(unrelated), null);
  assert.match(
    hypermediaNegotiationError(unrelated) ?? "",
    /No supported HTML or JSON representation/,
  );
});

test("compatibility helpers describe the selected representation", () => {
  const html = withAccept("text/html, application/json;q=0.5");
  assert.equal(acceptsHtml(html), true);
  assert.equal(acceptsJson(html), false);

  const json = withAccept("application/json, text/html;q=0.5");
  assert.equal(acceptsHtml(json), false);
  assert.equal(acceptsJson(json), true);

  const unacceptable = withAccept("application/json;q=0, text/html;q=0");
  assert.equal(acceptsHtml(unacceptable), false);
  assert.equal(acceptsJson(unacceptable), false);
});

test("application errors negotiate JSON media types while OAuth errors stay fixed", async () => {
  const vendorRequest = withAccept("application/vnd.aittadb+json;version=0.1");
  const vendorError = hypermediaError(
    vendorRequest,
    "invalid_request",
    "Invalid input",
    422,
  );
  assert.equal(vendorError.status, 422);
  assert.match(
    vendorError.headers.get("content-type") ?? "",
    /^application\/vnd\.aittadb\+json; version=0\.1/,
  );
  assert.equal(vendorError.headers.get("vary"), "Accept");
  assert.equal(
    ((await vendorError.json()) as { data: { error: string } }).data.error,
    "invalid_request",
  );

  const compatibilityError = hypermediaError(
    withAccept("application/json"),
    "not_found",
    undefined,
    404,
  );
  assert.equal(
    compatibilityError.headers.get("content-type"),
    "application/json; charset=utf-8",
  );

  const protocolError = oauthError("invalid_grant", "Invalid grant");
  assert.equal(
    protocolError.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(protocolError.headers.get("vary"), null);
  assert.equal(
    ((await protocolError.json()) as { error: string }).error,
    "invalid_grant",
  );
});
