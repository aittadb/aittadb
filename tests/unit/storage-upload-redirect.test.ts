import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionFileUploadPostResponse } from "../../src/storage-browser";

const CUSTOM_ORIGIN = "https://aittadb.com";
const SITES_ISSUER = "https://sites-auth-broker.example.chatgpt.site";

test("issuer-origin upload location is rewritten to the custom request origin", () => {
  const request = htmlRequest();
  const created = createdResponse(
    `${SITES_ISSUER}/storage/files/folder/note%20one.txt`,
  );
  assert.notEqual(new URL(request.url).origin, new URL(SITES_ISSUER).origin);

  const result = sessionFileUploadPostResponse(request, created, SITES_ISSUER);

  assert.notEqual(result, created);
  assert.equal(result.status, 303);
  assert.equal(
    result.headers.get("location"),
    `${CUSTOM_ORIGIN}/storage/files/folder/note%20one.txt`,
  );
  assert.match(result.headers.get("set-cookie") ?? "", /^aittadb_csrf=C{32};/);
});

test("request-origin upload location remains on the request origin", () => {
  const request = htmlRequest();
  const created = createdResponse(`${CUSTOM_ORIGIN}/storage/files/note.txt`);
  const result = sessionFileUploadPostResponse(request, created, SITES_ISSUER);

  assert.equal(result.status, 303);
  assert.equal(
    result.headers.get("location"),
    `${CUSTOM_ORIGIN}/storage/files/note.txt`,
  );
});

test("invalid upload locations retain the original 201 response", () => {
  const request = htmlRequest();

  const rejected = [
    null,
    "",
    `${CUSTOM_ORIGIN}/storage/files`,
    `${CUSTOM_ORIGIN}/storage/files/../admin/clients`,
    `${SITES_ISSUER}/storage/files/note.txt?download=1`,
    `${SITES_ISSUER}/storage/files/note.txt#fragment`,
    `${SITES_ISSUER}/storage/files/folder%2Fnote.txt`,
    "https://user:password@aittadb.com/storage/files/note.txt",
    "not an absolute URL",
  ];
  for (const location of rejected) {
    const created = createdResponse(location);
    const result = sessionFileUploadPostResponse(
      request,
      created,
      SITES_ISSUER,
    );
    assert.equal(result, created);
    assert.equal(result.status, 201);
  }
});

test("foreign upload locations retain the original 201", () => {
  const request = htmlRequest();
  for (const location of [
    "https://foreign.example.test/storage/files/note.txt",
  ]) {
    const created = createdResponse(location);
    const result = sessionFileUploadPostResponse(
      request,
      created,
      SITES_ISSUER,
    );
    assert.equal(result, created);
    assert.equal(result.status, 201);
  }
});

test("non-HTML and non-created responses remain unchanged", () => {
  const created = createdResponse(`${CUSTOM_ORIGIN}/storage/files/note.txt`);
  assert.equal(
    sessionFileUploadPostResponse(
      new Request(`${CUSTOM_ORIGIN}/storage/files`, {
        headers: { accept: "application/vnd.aittadb+json; version=0.1" },
      }),
      created,
      SITES_ISSUER,
    ),
    created,
  );

  const ok = new Response("{}", {
    status: 200,
    headers: {
      "content-type": "application/json",
      location: `${CUSTOM_ORIGIN}/storage/files/note.txt`,
    },
  });
  assert.equal(
    sessionFileUploadPostResponse(htmlRequest(), ok, SITES_ISSUER),
    ok,
  );
  assert.equal(
    sessionFileUploadPostResponse(
      htmlRequest(),
      created,
      "not an absolute issuer",
    ),
    created,
  );
});

function htmlRequest(): Request {
  return new Request(`${CUSTOM_ORIGIN}/storage/files`, {
    headers: {
      accept: "text/html",
      cookie: `aittadb_csrf=${"C".repeat(32)}`,
    },
  });
}

function createdResponse(location: string | null): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (location !== null) headers.set("location", location);
  return new Response("{}", { status: 201, headers });
}
