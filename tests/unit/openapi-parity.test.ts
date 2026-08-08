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
    "GET /privacy",
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

test("OpenAPI documents implemented security controls", () => {
  assert.doesNotMatch(JSON.stringify(openApiSpec), /\bADMIN_[A-Z_]+\b/);

  for (const path of ["/storage/records", "/storage/files"]) {
    const parameters = openApiOperation(path, "get").parameters;
    assert.ok(Array.isArray(parameters));
    const names = parameters.map((parameter) =>
      String(asObject(parameter, "parameter").name),
    );
    assert.ok(names.includes("page_size"), `${path} must document page_size`);
    assert.ok(names.includes("cursor"), `${path} must document cursor`);
    const cursor = (parameters as UnknownObject[]).find(
      (parameter) => String(parameter.name) === "cursor",
    );
    assert.match(String(cursor?.description), /encrypted continuation cursor/);
  }

  const collectionData = openApiSchema("StorageCollectionData");
  assert.deepEqual(collectionData.required, [
    "count",
    "page_size",
    "has_more",
    "usage",
    "items",
  ]);
  const collectionProperties = asObject(
    collectionData.properties,
    "StorageCollectionData.properties",
  );
  assert.equal(
    asObject(collectionProperties.usage, "StorageCollectionData.usage").$ref,
    "#/components/schemas/StorageNamespaceUsage",
  );
  assert.deepEqual(openApiSchema("StorageNamespaceUsage").required, [
    "item_count",
    "byte_count",
    "item_limit",
    "byte_limit",
    "writes_enabled",
  ]);

  for (const [path, method] of [
    ["/authorize", "get"],
    ["/oauth/device_authorization", "post"],
    ["/oauth/token", "post"],
    ["/oauth/revoke", "post"],
    ["/oauth/introspect", "post"],
    ["/storage/records", "get"],
    ["/storage/records", "post"],
    ["/storage/records/{key}", "get"],
    ["/storage/records/{key}", "post"],
    ["/storage/records/{key}", "put"],
    ["/storage/records/{key}", "delete"],
    ["/storage/files", "get"],
    ["/storage/files", "post"],
    ["/storage/files/{key}", "get"],
    ["/storage/files/{key}", "post"],
    ["/storage/files/{key}", "put"],
    ["/storage/files/{key}", "delete"],
    ["/admin/clients", "get"],
    ["/admin/clients", "post"],
  ] as const) {
    assert.ok(
      "429" in operationResponses(path, method),
      `${method.toUpperCase()} ${path} must document 429`,
    );
  }

  for (const [path, method] of [
    ["/storage/records", "post"],
    ["/storage/records/{key}", "post"],
    ["/storage/records/{key}", "put"],
    ["/storage/files", "post"],
    ["/storage/files/{key}", "post"],
    ["/storage/files/{key}", "put"],
  ] as const) {
    const responses = operationResponses(path, method);
    assert.ok("503" in responses, `${method.toUpperCase()} ${path} needs 503`);
    assert.ok("507" in responses, `${method.toUpperCase()} ${path} needs 507`);
  }

  for (const [path, method] of [
    ["/userinfo", "get"],
    ["/storage/records", "get"],
    ["/storage/records/{key}", "get"],
    ["/storage/records/{key}", "put"],
    ["/storage/records/{key}", "delete"],
    ["/storage/files", "get"],
    ["/storage/files", "post"],
    ["/storage/files/{key}", "get"],
    ["/storage/files/{key}", "put"],
    ["/storage/files/{key}", "delete"],
  ] as const) {
    const description = String(openApiOperation(path, method).description);
    assert.match(description, /Origin must exactly match/);
    assert.match(description, /active OAuth client/);
  }

  const userInfoUnauthorized = asObject(
    operationResponses("/userinfo", "get")["401"],
    "UserInfo 401 response",
  );
  assert.match(String(userInfoUnauthorized.description), /disabled audience/);
  assert.match(
    String(openApiOperation("/oauth/token", "post").description),
    /before any authorization code, device code, or refresh token is consumed/,
  );
  for (const [path, method] of [
    ["/storage/files", "post"],
    ["/storage/files/{key}", "post"],
    ["/storage/files/{key}", "put"],
    ["/storage/files/{key}", "delete"],
  ] as const) {
    assert.ok(
      "409" in operationResponses(path, method),
      `${method.toUpperCase()} ${path} must document concurrent conflicts`,
    );
  }

  const schemes = asObject(
    asObject(openApiSpec.components, "components").securitySchemes,
    "securitySchemes",
  );
  assert.equal("adminAccessKey" in schemes, false);
  assert.equal("adminSession" in schemes, false);
  assert.equal(
    "OAuthAdminUnlockInput" in
      asObject(
        asObject(openApiSpec.components, "components").schemas,
        "schemas",
      ),
    false,
  );
  for (const method of ["get", "post"] as const) {
    assert.equal(
      openApiOperation("/admin/clients", method)[
        "x-aittadb-sites-identity-required"
      ],
      true,
    );
  }
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

type UnknownObject = Record<string, unknown>;

function asObject(value: unknown, label: string): UnknownObject {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as UnknownObject;
}

function openApiOperation(path: string, method: string): UnknownObject {
  const paths = asObject(openApiSpec.paths, "paths");
  return asObject(asObject(paths[path], path)[method], `${method} ${path}`);
}

function operationResponses(path: string, method: string): UnknownObject {
  return asObject(
    openApiOperation(path, method).responses,
    `${method} ${path} responses`,
  );
}

function openApiSchema(name: string): UnknownObject {
  const components = asObject(openApiSpec.components, "components");
  const schemas = asObject(components.schemas, "schemas");
  return asObject(schemas[name], name);
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
