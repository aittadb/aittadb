import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  extractDelegatedStorageOperations,
  extractImplementedOperations,
  findLegacyLinksLocations,
  type StorageRouteSources,
  validateOpenApiSpec,
} from "../../scripts/check-openapi";
import { openApiSpec } from "../../src/openapi";

test("OpenAPI guard derives exact and delegated executable operations", async () => {
  const { handlerSource, storageSources } = await routeSources();
  const operations = new Set(
    extractImplementedOperations(handlerSource, storageSources).map(
      ({ method, path }) => `${method.toUpperCase()} ${path}`,
    ),
  );

  for (const operation of [
    "GET /statistics",
    "POST /storage/files",
    "POST /device/decision",
    "POST /consent",
    "GET /admin/clients",
    "POST /admin/clients",
    "GET /storage/records",
    "POST /storage/records",
    "GET /storage/records/{key}",
    "POST /storage/records/{key}",
    "PUT /storage/records/{key}",
    "DELETE /storage/records/{key}",
    "GET /storage/files",
    "POST /storage/files",
    "GET /storage/files/{key}",
    "POST /storage/files/{key}",
    "PUT /storage/files/{key}",
    "DELETE /storage/files/{key}",
  ]) {
    assert.ok(operations.has(operation), `missing ${operation}`);
  }
});

test("delegated storage checks cannot fall back to an implicit inventory", async () => {
  const { handlerSource } = await routeSources();
  assert.throws(
    () => extractImplementedOperations(handlerSource),
    /requires endpoint and browser dispatcher sources/,
  );
});

test("OpenAPI parity fails when a canonical storage method changes", async () => {
  const { handlerSource, storageSources } = await routeSources();
  const endpoint = replaceRecordMethod(
    storageSources.endpoint,
    'request.method === "DELETE"',
    'request.method === "PATCH"',
  );
  const changedSources = { ...storageSources, endpoint };
  const operations = operationSet(
    extractDelegatedStorageOperations(changedSources),
  );

  assert.ok(operations.has("PATCH /storage/records/{key}"));
  assert.ok(!operations.has("DELETE /storage/records/{key}"));
  const errors = validateOpenApiSpec(
    openApiSpec,
    handlerSource,
    changedSources,
  );
  assert.ok(
    errors.includes("Missing OpenAPI operation: PATCH /storage/records/{key}"),
  );
  assert.ok(
    errors.includes(
      "OpenAPI operation has no handler: DELETE /storage/records/{key}",
    ),
  );
});

test("OpenAPI parity follows browser storage method routing", async () => {
  const { handlerSource, storageSources } = await routeSources();
  const browser = replaceExactlyOnce(
    storageSources.browser,
    'request.method !== "POST"',
    'request.method !== "PATCH"',
  );
  const changedSources = { ...storageSources, browser };
  const operations = operationSet(
    extractDelegatedStorageOperations(changedSources),
  );

  assert.ok(operations.has("PATCH /storage/files/{key}"));
  assert.ok(!operations.has("POST /storage/records"));
  const errors = validateOpenApiSpec(
    openApiSpec,
    handlerSource,
    changedSources,
  );
  assert.ok(
    errors.includes("Missing OpenAPI operation: PATCH /storage/files/{key}"),
  );
  assert.ok(
    errors.includes("OpenAPI operation has no handler: POST /storage/records"),
  );
});

test("OpenAPI guard locates legacy _links members without rejecting links", () => {
  const locations = findLegacyLinksLocations({
    schemas: {
      Legacy: {
        required: ["data", "_links"],
        properties: { _links: { type: "object" } },
      },
      Current: {
        required: ["data", "links", "actions"],
        properties: { links: { type: "array" } },
      },
    },
  });

  assert.deepEqual(locations, [
    "$.schemas.Legacy.required[_links]",
    "$.schemas.Legacy.properties._links",
  ]);
});

async function routeSources(): Promise<{
  handlerSource: string;
  storageSources: StorageRouteSources;
}> {
  const [handlerSource, endpoint, browser] = await Promise.all([
    readFile(new URL("../../src/handler.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/storage-browser.ts", import.meta.url), "utf8"),
  ]);
  return { handlerSource, storageSources: { endpoint, browser } };
}

function operationSet(
  operations: readonly { method: string; path: string }[],
): Set<string> {
  return new Set(
    operations.map(({ method, path }) => `${method.toUpperCase()} ${path}`),
  );
}

function replaceRecordMethod(
  source: string,
  before: string,
  after: string,
): string {
  const start = source.indexOf("const recordKey = decodeStorageKey");
  const end = source.indexOf('if (url.pathname === "/storage/files"', start);
  assert.notEqual(start, -1, "record route block must exist");
  assert.notEqual(end, -1, "file route block must follow records");
  const recordRoutes = replaceExactlyOnce(
    source.slice(start, end),
    before,
    after,
  );
  return `${source.slice(0, start)}${recordRoutes}${source.slice(end)}`;
}

function replaceExactlyOnce(
  source: string,
  before: string,
  after: string,
): string {
  const first = source.indexOf(before);
  assert.notEqual(first, -1, `fixture must contain ${before}`);
  assert.equal(
    source.indexOf(before, first + before.length),
    -1,
    `fixture must contain exactly one ${before}`,
  );
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}
