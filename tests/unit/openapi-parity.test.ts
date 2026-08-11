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
import { oidcConfiguration, openApiSpec } from "../../src/openapi";

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
    "GET /account/deletion",
    "POST /account/deletion",
    "GET /events",
    "POST /events",
    "POST /storage/files",
    "POST /device/decision",
    "POST /consent",
    "GET /admin/clients",
    "POST /admin/clients",
    "GET /events/{id}",
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

test("OpenAPI documents the bounded isolated event publication contract", () => {
  const get = openApiOperation("/events", "get");
  assert.equal(get["x-aittadb-sites-session-supported"], true);
  assert.match(String(get.description), /events\.read/);
  assert.match(String(get.description), /never returned/);

  const post = openApiOperation("/events", "post");
  const description = String(post.description);
  for (const pattern of [
    /events\.publish/,
    /subject and client namespace only from the verified token/,
    /atomically admits/,
    /no fan-out/,
    /hashed at rest/,
    /Origin must exactly match/,
  ]) {
    assert.match(description, pattern);
  }
  assert.equal(post["x-aittadb-sites-session-alternative"], true);

  const requestBody = asObject(post.requestBody, "event request body");
  const content = asObject(requestBody.content, "event request content");
  assert.ok("application/json" in content);
  assert.ok("application/x-www-form-urlencoded" in content);
  assert.deepEqual(openApiSchema("EventPublicationInput").required, [
    "type",
    "data",
  ]);
  assert.deepEqual(openApiSchema("ApplicationEventData").required, [
    "id",
    "type",
    "data",
    "created_at",
    "expires_at",
  ]);
  assert.doesNotMatch(
    JSON.stringify(openApiSchema("ApplicationEventData")),
    /client_id|user_id|sequence|request_hash|idempotency_key_hash/,
  );

  const responses = operationResponses("/events", "post");
  for (const status of [
    "200",
    "201",
    "400",
    "401",
    "403",
    "409",
    "413",
    "415",
    "429",
    "503",
    "507",
  ]) {
    assert.ok(status in responses, `POST /events must document ${status}`);
  }
  assert.match(
    String(asObject(responses["409"], "event conflict").description),
    /different event content/,
  );
  assert.match(
    String(asObject(responses["507"], "event quota").description),
    /atomic append/,
  );
});

test("OpenAPI and discovery document the bounded service-client grant", () => {
  const token = openApiOperation("/oauth/token", "post");
  assert.match(String(token.description), /service client/);
  assert.match(
    String(token.description),
    /no user claims, ID token, or refresh token/,
  );
  const requestBody = asObject(token.requestBody, "token request body");
  const content = asObject(requestBody.content, "token content");
  const encoded = asObject(
    content["application/x-www-form-urlencoded"],
    "encoded token body",
  );
  const schema = asObject(encoded.schema, "token schema");
  const properties = asObject(schema.properties, "token properties");
  assert.ok(
    (asObject(properties.grant_type, "grant type").enum as unknown[]).includes(
      "client_credentials",
    ),
  );
  assert.ok("scope" in properties);

  const create = openApiSchema("OAuthClientCreateInput");
  const createProperties = asObject(create.properties, "client properties");
  assert.ok(
    (asObject(createProperties.type, "client type").enum as unknown[]).includes(
      "service",
    ),
  );
  assert.equal((create.required as unknown[]).includes("redirect_uris"), false);

  const discovery = oidcConfiguration("https://aittadb.example.test");
  assert.ok(discovery.grant_types_supported?.includes("client_credentials"));
});

test("OpenAPI documents the bounded authenticated account deletion request", () => {
  const operation = openApiOperation("/account/deletion", "post");
  assert.equal(operation["x-aittadb-sites-identity-required"], true);
  assert.match(String(operation.description), /never creates or updates/);
  assert.match(String(operation.description), /1 KiB/);
  assert.match(String(operation.description), /exact local subject/);
  assert.match(String(operation.description), /exact trusted email/);
  assert.match(String(operation.description), /Administrators/);
  assert.match(String(operation.description), /waitUntil/);
  assert.match(
    String(operation.description),
    /separate seven-day status handle/,
  );
  assert.match(
    String(operation.description),
    /does not.*define re-registration/,
  );

  const requestBody = asObject(operation.requestBody, "request body");
  const content = asObject(requestBody.content, "request body content");
  assert.ok("application/x-www-form-urlencoded" in content);
  assert.ok("application/json" in content);
  const input = openApiSchema("AccountDeletionRequestInput");
  assert.deepEqual(input.required, [
    "csrf_token",
    "confirmation_token",
    "confirmation",
  ]);
  const properties = asObject(input.properties, "deletion input properties");
  assert.equal(
    asObject(properties.confirmation, "confirmation").const,
    "delete my account",
  );
  assert.equal(
    asObject(properties.confirmation_token, "confirmation token").maxLength,
    512,
  );

  const responses = operationResponses("/account/deletion", "post");
  for (const status of [
    "202",
    "400",
    "403",
    "413",
    "415",
    "429",
    "503",
    "406",
  ]) {
    assert.ok(status in responses, `missing account deletion ${status}`);
  }
  assert.match(
    String(asObject(responses["202"], "accepted response").description),
    /no subject, job, attempt, timestamp, count, namespace, client, storage, identity, or credential value/,
  );
  const acceptedHeaders = asObject(
    asObject(responses["202"], "accepted response").headers,
    "accepted response headers",
  );
  assert.match(
    String(
      asObject(acceptedHeaders["Set-Cookie"], "status cookie").description,
    ),
    /HttpOnly.*Secure.*SameSite=Lax.*Path=\/account\/deletion.*Max-Age=604800/,
  );
  assert.match(
    String(openApiOperation("/session", "get").description),
    /encrypted confirmation value exposes no subject or email/,
  );
});

test("OpenAPI documents the encrypted account deletion status resource", () => {
  const operation = openApiOperation("/account/deletion", "get");
  assert.equal(operation["x-aittadb-sites-identity-required"], true);
  for (const pattern of [
    /seven-day, host-only HttpOnly status cookie/,
    /distinct HKDF purpose/,
    /before any repository work/,
    /never calls getUserByEmail or findOrCreateUser/,
    /performs one exact deletion-job lookup/,
    /exactly one caught bounded coordinator pass/,
    /completed exposes only the Sites-owned sign-out transition/,
  ]) {
    assert.match(String(operation.description), pattern);
  }

  const parameters = operation.parameters as unknown[];
  assert.equal(parameters.length, 1);
  const cookie = asObject(parameters[0], "status cookie parameter");
  assert.equal(cookie.name, "aittadb_account_deletion_status");
  assert.equal(cookie.in, "cookie");
  assert.equal(cookie.required, true);

  const responses = operationResponses("/account/deletion", "get");
  for (const status of ["200", "400", "503", "406"]) {
    assert.ok(status in responses, `missing account deletion status ${status}`);
  }
  assert.match(
    String(asObject(responses["400"], "invalid status response").description),
    /no repository or background work.*coarse no-store response/,
  );
  assert.match(
    String(
      asObject(responses["503"], "unavailable status response").description,
    ),
    /D1 is unavailable.*R2 or waitUntil is unavailable.*No coordinator pass is scheduled/,
  );

  const schema = openApiSchema("AccountDeletionStatusDocument");
  const allOf = schema.allOf as unknown[];
  const shape = asObject(allOf[1], "status document shape");
  const properties = asObject(shape.properties, "status document properties");
  const data = asObject(properties.data, "status data");
  const dataProperties = asObject(data.properties, "status data properties");
  assert.deepEqual(asObject(dataProperties.status, "status").enum, [
    "pending",
    "running",
    "retry",
    "completed",
  ]);
});

test("OpenAPI documents the statistics feature gate", () => {
  const operation = openApiOperation("/statistics", "get");
  assert.match(
    String(operation.description),
    /FEATURE_STATISTICS_ENABLED is true/,
  );
  assert.match(String(operation.description), /before any aggregate query/);

  const unavailable = asObject(
    operationResponses("/statistics", "get")["503"],
    "statistics unavailable response",
  );
  assert.match(String(unavailable.description), /feature_unavailable/);
  assert.match(String(unavailable.description), /before any aggregate query/);
  const content = asObject(
    unavailable.content,
    "statistics unavailable content",
  );
  assert.ok("application/json" in content);
  assert.ok("application/vnd.aittadb+json; version=0.1" in content);
  assert.ok("text/html" in content);

  const featureProperties = asObject(
    asObject(
      openApiSchema("ServiceMetadataData").properties,
      "service properties",
    ).features,
    "feature availability",
  );
  const statistics = asObject(
    asObject(featureProperties.properties, "feature properties").statistics,
    "statistics feature",
  );
  assert.match(String(statistics.description), /GET \/statistics/);
  assert.match(String(statistics.description), /before querying D1/);
});

test("OpenAPI documents the File Storage feature gate", () => {
  for (const [path, method] of [
    ["/storage/files", "get"],
    ["/storage/files", "post"],
    ["/storage/files/{key}", "get"],
    ["/storage/files/{key}", "post"],
    ["/storage/files/{key}", "put"],
    ["/storage/files/{key}", "delete"],
  ] as const) {
    const unavailable = asObject(
      operationResponses(path, method)["503"],
      `${method.toUpperCase()} ${path} unavailable response`,
    );
    assert.match(String(unavailable.description), /File Storage feature/);
    assert.match(String(unavailable.description), /before client lookup/);
    assert.match(String(unavailable.description), /D1 file-metadata work/);
    assert.match(String(unavailable.description), /R2 access/);
    const content = asObject(unavailable.content, "unavailable content");
    assert.ok("application/json" in content);
    assert.ok("application/vnd.aittadb+json; version=0.1" in content);
    assert.ok("text/html" in content);
  }

  const featureProperties = asObject(
    asObject(
      openApiSchema("ServiceMetadataData").properties,
      "service properties",
    ).features,
    "feature availability",
  );
  const files = asObject(
    asObject(featureProperties.properties, "feature properties").files,
    "files feature",
  );
  assert.match(String(files.description), /file routes return 503/);
  assert.match(String(files.description), /before D1 metadata, R2, or cleanup/);
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

test("OpenAPI distinguishes licensing posture from the current Sites dependency", () => {
  assert.match(openApiSpec.info.description, /source-available project/);
  assert.match(openApiSpec.info.description, /FSL-1\.1-MIT/);
  assert.match(
    openApiSpec.info.description,
    /MIT license for immediate use is also available commercially/,
  );
  assert.doesNotMatch(
    openApiSpec.info.description,
    /third-party, non-official project/,
  );
  assert.match(
    openApiSpec.info.description,
    /depends on OpenAI-hosted ChatGPT Sites for runtime, ChatGPT sign-in, D1, R2, configuration, and secrets/,
  );
  assert.doesNotMatch(openApiSpec.info.description, /AittaDB is independent/);

  const rootDescription = String(openApiOperation("/", "get").description);
  assert.match(rootDescription, /licensing posture/);
  assert.match(rootDescription, /platform dependency/);

  const serviceProperties = asObject(
    openApiSchema("ServiceMetadataData").properties,
    "ServiceMetadataData properties",
  );
  const hostingPlatform = asObject(
    serviceProperties.hostingPlatform,
    "hostingPlatform",
  );
  const officialOpenAIProduct = asObject(
    serviceProperties.officialOpenAIProduct,
    "officialOpenAIProduct",
  );
  const features = asObject(serviceProperties.features, "features");
  assert.deepEqual(features.required, [
    "records",
    "files",
    "statistics",
    "oauthApps",
    "events",
  ]);
  const featureProperties = asObject(
    features.properties,
    "features properties",
  );
  assert.equal(asObject(featureProperties.records, "records").default, true);
  assert.equal(asObject(featureProperties.files, "files").default, true);
  assert.equal(
    asObject(featureProperties.statistics, "statistics").default,
    true,
  );
  assert.equal(
    asObject(featureProperties.oauthApps, "oauthApps").default,
    false,
  );
  assert.equal(asObject(featureProperties.events, "events").default, false);
  assert.equal(
    Object.hasOwn(openApiSpec.paths, "/events"),
    true,
    "feature metadata must document the implemented gated Events collection and publication route",
  );
  assert.equal(Object.hasOwn(openApiSpec.paths, "/events/{id}"), true);
  assert.match(String(hostingPlatform.description), /depends on this platform/);
  assert.match(
    String(officialOpenAIProduct.description),
    /does not imply technical independence/,
  );
});

test("OpenAPI documents bounded event collection reads", () => {
  const operation = openApiOperation("/events", "get");
  assert.match(String(operation.description), /events\.read/);
  assert.match(String(operation.description), /oldest-first/);
  assert.match(String(operation.description), /exact type/);
  assert.match(String(operation.description), /events\.subscribe/);
  assert.match(String(operation.description), /valid cursor/);
  assert.deepEqual(operation.security, [{ bearer: [] }]);
  const parameters = operation.parameters as Array<Record<string, unknown>>;
  assert.deepEqual(
    parameters.map((parameter) => parameter.name),
    ["page_size", "cursor", "type", "wait"],
  );
  const responses = asObject(operation.responses, "Events responses");
  assert.ok(responses["200"]);
  assert.ok(responses["400"]);
  assert.ok(responses["401"]);
  assert.ok(responses["403"]);
  assert.ok(responses["429"]);
  assert.ok(responses["499"]);
  assert.ok(responses["503"]);
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
    const description = String(cursor?.description);
    assert.match(description, /encrypted continuation cursor/);
    assert.match(
      description,
      /logical key, timestamp, local-user identifier, OAuth-client identifier, or signing secret/,
    );
    assert.match(description, /private signing-key material/);
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
    ["/events/{id}", "get"],
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
    ["/storage/records", "get"],
    ["/storage/records", "post"],
    ["/storage/records/{key}", "get"],
    ["/storage/records/{key}", "post"],
    ["/storage/records/{key}", "put"],
    ["/storage/records/{key}", "delete"],
  ] as const) {
    const unavailable = asObject(
      operationResponses(path, method)["503"],
      `${method.toUpperCase()} ${path} 503 response`,
    );
    assert.match(String(unavailable.description), /JSON Records feature/);
    assert.match(String(unavailable.description), /before client lookup/);
  }

  for (const [path, method] of [
    ["/userinfo", "get"],
    ["/events/{id}", "get"],
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

  const eventRead = openApiOperation("/events/{id}", "get");
  assert.equal(eventRead["x-aittadb-sites-session-supported"], true);
  assert.match(String(eventRead.description), /events\.read/);
  assert.match(String(eventRead.description), /No update or delete/);
  assert.ok("404" in operationResponses("/events/{id}", "get"));
  assert.deepEqual(
    Object.keys(asObject(openApiSpec.paths["/events/{id}"], "event item path")),
    ["get"],
  );
  const eventDocumentParts = openApiSchema("ApplicationEventDocument").allOf;
  assert.ok(Array.isArray(eventDocumentParts));
  const eventDocumentProperties = asObject(
    asObject(eventDocumentParts[1], "event document specialization").properties,
    "event document properties",
  );
  assert.equal(
    asObject(eventDocumentProperties.actions, "event actions").maxItems,
    0,
  );
  const eventDataProperties = asObject(
    openApiSchema("ApplicationEventData").properties,
    "event data properties",
  );
  assert.deepEqual(Object.keys(eventDataProperties), [
    "id",
    "type",
    "data",
    "created_at",
    "expires_at",
  ]);

  const userInfoUnauthorized = asObject(
    operationResponses("/userinfo", "get")["401"],
    "UserInfo 401 response",
  );
  assert.match(String(userInfoUnauthorized.description), /disabled audience/);
  assert.match(
    String(openApiOperation("/oauth/token", "post").description),
    /before any authorization code, device code, or refresh token is consumed/,
  );
  const introspectionDescription = String(
    openApiOperation("/oauth/introspect", "post").description,
  );
  assert.match(introspectionDescription, /token_use is access/);
  assert.match(introspectionDescription, /audience is the authenticated/);
  assert.match(introspectionDescription, /ID tokens, opaque refresh tokens/);
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
    assert.ok(
      "406" in operationResponses("/admin/clients", method),
      `${method.toUpperCase()} administration must document negotiation failure`,
    );
  }
  const adminGetDescription = String(
    openApiOperation("/admin/clients", "get").description,
  );
  assert.match(adminGetDescription, /same availability policy/);
  assert.match(adminGetDescription, /confidential and service clients/);
  const adminPostResponses = operationResponses("/admin/clients", "post");
  for (const status of ["409", "413", "415"]) {
    assert.ok(
      status in adminPostResponses,
      `admin POST must document ${status}`,
    );
  }
  assert.ok("303" in adminPostResponses);
  assert.match(
    String(asObject(adminPostResponses["303"], "admin redirect").description),
    /does not repeat the POST/,
  );
  assert.match(
    String(asObject(adminPostResponses["409"], "admin conflict").description),
    /already used/,
  );
  for (const schemaName of [
    "OAuthClientCreateInput",
    "OAuthClientOperationInput",
  ]) {
    const schema = openApiSchema(schemaName);
    assert.ok(
      Array.isArray(schema.required) &&
        schema.required.includes("submission_token"),
      `${schemaName} must require the advertised one-time submission`,
    );
  }
  const adminCollection = openApiSchema("OAuthClientCollectionDocument");
  const collectionVariants = adminCollection.allOf;
  assert.ok(Array.isArray(collectionVariants));
  const collectionShape = asObject(
    collectionVariants[1],
    "OAuthClientCollectionDocument shape",
  );
  const adminCollectionData = asObject(
    asObject(collectionShape.properties, "admin collection properties").data,
    "admin collection data",
  );
  const adminDataProperties = asObject(
    adminCollectionData.properties,
    "admin collection data properties",
  );
  assert.equal(
    asObject(adminDataProperties.new_client_secret, "new client secret")
      .readOnly,
    true,
  );
  assert.equal(
    asObject(
      adminDataProperties.new_client_secret_client_id,
      "new client secret client id",
    ).format,
    "uuid",
  );
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
