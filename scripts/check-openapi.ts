import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import { openApiSpec } from "../src/openapi";

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];
export interface Operation {
  path: string;
  method: HttpMethod;
}

export interface StorageRouteSources {
  endpoint: string;
  browser: string;
}

type UnknownRecord = Record<string, unknown>;
interface ResponseRequirement extends Operation {
  status: string;
  mediaTypes: readonly string[];
}
interface RequestRequirement extends Operation {
  mediaTypes: readonly string[];
}

const JSON_MEDIA = "application/json";
const HYPERMEDIA_MEDIA = "application/vnd.aittadb+json";
const HTML_MEDIA = "text/html";
const BINARY_MEDIA = "application/octet-stream";
const FORM_MEDIA = "application/x-www-form-urlencoded";
const MULTIPART_MEDIA = "multipart/form-data";
const HYPERMEDIA_JSON = [JSON_MEDIA, HYPERMEDIA_MEDIA] as const;
const HYPERMEDIA_HTML = [...HYPERMEDIA_JSON, HTML_MEDIA] as const;
const STANDARD_HTML = [JSON_MEDIA, HTML_MEDIA] as const;

const RESPONSE_REQUIREMENTS: readonly ResponseRequirement[] = [
  response("/", "get", "200", HYPERMEDIA_HTML),
  response("/health", "get", "200", HYPERMEDIA_HTML),
  response("/privacy", "get", "200", HYPERMEDIA_HTML),
  response("/statistics", "get", "200", HYPERMEDIA_HTML),
  response("/session", "get", "200", HYPERMEDIA_HTML),
  response("/authorize", "get", "200", HYPERMEDIA_HTML),
  response("/authorize", "get", "302"),
  response("/oauth/device_authorization", "get", "200", HYPERMEDIA_HTML),
  response("/oauth/token", "get", "200", HYPERMEDIA_HTML),
  response("/oauth/revoke", "get", "200", HYPERMEDIA_HTML),
  response("/oauth/introspect", "get", "200", HYPERMEDIA_HTML),
  response("/userinfo", "get", "200", HYPERMEDIA_HTML),
  response("/events", "get", "200", HYPERMEDIA_HTML),
  response("/events/{id}", "get", "200", HYPERMEDIA_HTML),
  response("/events", "post", "200", HYPERMEDIA_HTML),
  response("/events", "post", "201", HYPERMEDIA_HTML),
  response("/storage/records", "get", "200", HYPERMEDIA_HTML),
  response("/storage/records", "post", "200", HYPERMEDIA_HTML),
  response("/storage/records/{key}", "get", "200", HYPERMEDIA_HTML),
  response("/storage/records/{key}", "post", "200", HYPERMEDIA_HTML),
  response("/storage/records/{key}", "put", "200", HYPERMEDIA_JSON),
  response("/storage/records/{key}", "delete", "200", HYPERMEDIA_JSON),
  response("/storage/files", "get", "200", HYPERMEDIA_HTML),
  response("/storage/files", "post", "200", HYPERMEDIA_HTML),
  response("/storage/files", "post", "201", HYPERMEDIA_HTML),
  response("/storage/files/{key}", "get", "200", [
    ...HYPERMEDIA_HTML,
    BINARY_MEDIA,
  ]),
  response("/storage/files/{key}", "post", "200", [
    ...HYPERMEDIA_HTML,
    BINARY_MEDIA,
  ]),
  response("/storage/files/{key}", "put", "200", HYPERMEDIA_JSON),
  response("/storage/files/{key}", "delete", "200", HYPERMEDIA_JSON),
  response("/device", "get", "200", HYPERMEDIA_HTML),
  response("/device", "post", "200", HYPERMEDIA_HTML),
  response("/device/decision", "post", "200", HYPERMEDIA_HTML),
  response("/consent", "get", "200", HYPERMEDIA_HTML),
  response("/consent", "get", "302"),
  response("/consent", "post", "302"),
  response("/admin/clients", "get", "200", HYPERMEDIA_HTML),
  response("/admin/clients", "post", "200", HYPERMEDIA_JSON),
  response("/admin/clients", "post", "303"),

  // Successful protocol payloads remain standards-defined rather than wrapped.
  response("/.well-known/openid-configuration", "get", "200", STANDARD_HTML),
  response("/.well-known/jwks.json", "get", "200", STANDARD_HTML),
  response("/openapi.json", "get", "200", STANDARD_HTML),
  response("/oauth/device_authorization", "post", "200", STANDARD_HTML),
  response("/oauth/token", "post", "200", STANDARD_HTML),
  response("/oauth/revoke", "post", "200", STANDARD_HTML),
  response("/oauth/introspect", "post", "200", STANDARD_HTML),
  response("/userinfo", "post", "200", STANDARD_HTML),
  response("/docs", "get", "200", [HTML_MEDIA]),
  response("/auth-ui.css", "get", "200", ["text/css"]),
  response("/auth-ui.js", "get", "200", ["text/javascript"]),
];

const REQUEST_REQUIREMENTS: readonly RequestRequirement[] = [
  request("/oauth/device_authorization", "post", [FORM_MEDIA]),
  request("/oauth/token", "post", [FORM_MEDIA]),
  request("/oauth/revoke", "post", [FORM_MEDIA]),
  request("/oauth/introspect", "post", [FORM_MEDIA]),
  request("/userinfo", "post", [FORM_MEDIA]),
  request("/events", "post", [JSON_MEDIA, FORM_MEDIA]),
  request("/storage/records", "post", [FORM_MEDIA]),
  request("/storage/records/{key}", "post", [FORM_MEDIA]),
  request("/storage/files", "post", [BINARY_MEDIA, MULTIPART_MEDIA]),
  request("/storage/files/{key}", "post", [FORM_MEDIA, MULTIPART_MEDIA]),
  request("/device", "post", [FORM_MEDIA]),
  request("/device/decision", "post", [FORM_MEDIA]),
  request("/consent", "post", [FORM_MEDIA]),
  request("/admin/clients", "post", [FORM_MEDIA]),
];

export function extractImplementedOperations(
  handlerSource: string,
  storageSources?: StorageRouteSources,
): Operation[] {
  const operations = new Map<string, Operation>();
  const patterns = [
    /url\.pathname\s*===\s*["']([^"']+)["']\s*&&\s*request\.method\s*===\s*["']([A-Z]+)["']/g,
    /request\.method\s*===\s*["']([A-Z]+)["']\s*&&\s*url\.pathname\s*===\s*["']([^"']+)["']/g,
  ];

  for (const [index, pattern] of patterns.entries()) {
    for (const match of handlerSource.matchAll(pattern)) {
      const path = index === 0 ? match[1] : match[2];
      const method = (index === 0 ? match[2] : match[1]).toLowerCase();
      if (!isHttpMethod(method)) continue;
      addOperation(operations, { path, method });
    }
  }

  if (/url\.pathname\.startsWith\(["']\/storage\/["']\)/.test(handlerSource)) {
    if (!storageSources) {
      throw new Error(
        "Storage route delegation requires endpoint and browser dispatcher sources",
      );
    }
    for (const delegated of extractDelegatedStorageOperations(storageSources)) {
      addOperation(operations, delegated);
    }
  }
  if (
    /url\.pathname\.startsWith\(["']\/events\/["']\)[\s\S]{0,160}request\.method\s*!==\s*["']GET["']/.test(
      handlerSource,
    )
  ) {
    addOperation(operations, { path: "/events/{id}", method: "get" });
  }
  if (
    /url\.pathname\s*===\s*["']\/events["'][\s\S]{0,120}request\.method\s*===\s*["']GET["']/.test(
      handlerSource,
    )
  ) {
    addOperation(operations, { path: "/events", method: "get" });
  }
  return [...operations.values()].sort(compareOperations);
}

export function extractDelegatedStorageOperations(
  sources: StorageRouteSources,
): Operation[] {
  const endpoint = parseTypeScript(sources.endpoint, "src/storage.ts");
  const browser = parseTypeScript(sources.browser, "src/storage-browser.ts");
  const endpointFunction = requireFunction(endpoint, "storageEndpoint");
  const browserFunction = requireFunction(browser, "storageBrowserEndpoint");
  const storageKindFunction = requireFunction(browser, "storageKind");
  const operations = new Map<string, Operation>();

  for (const candidate of exactRouteOperations(endpointFunction)) {
    addOperation(operations, candidate);
  }
  for (const candidate of keyedRouteOperations(endpointFunction)) {
    addOperation(operations, candidate);
  }

  const browserMethods = comparedMethods(browserFunction, true);
  const browserPaths = browserStoragePaths(storageKindFunction);
  if (browserMethods.length === 0 || browserPaths.length === 0) {
    throw new Error(
      "Unable to derive delegated storage routes from storageBrowserEndpoint and storageKind",
    );
  }
  for (const path of browserPaths) {
    for (const method of browserMethods) {
      addOperation(operations, { path, method });
    }
  }

  if (operations.size === 0) {
    throw new Error("Unable to derive delegated storage operations");
  }
  return [...operations.values()].sort(compareOperations);
}

function parseTypeScript(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function requireFunction(
  source: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  forEachNode(source, (node) => {
    if (
      !found &&
      ts.isFunctionDeclaration(node) &&
      node.name?.text === name &&
      node.body
    ) {
      found = node;
    }
  });
  if (!found)
    throw new Error(`Unable to find executable route function ${name}`);
  return found;
}

function exactRouteOperations(
  routeFunction: ts.FunctionDeclaration,
): Operation[] {
  const operations: Operation[] = [];
  forEachNode(routeFunction.body!, (node) => {
    if (!ts.isIfStatement(node)) return;
    const paths = comparedStrings(
      node.expression,
      (candidate) => propertyAccess(candidate, "url", "pathname"),
      false,
    ).filter(isStoragePath);
    const methods = comparedMethods(node.expression, false);
    for (const path of paths) {
      for (const method of methods) operations.push({ path, method });
    }
  });
  return operations;
}

function keyedRouteOperations(
  routeFunction: ts.FunctionDeclaration,
): Operation[] {
  const keyedPaths = new Map<string, string>();
  forEachNode(routeFunction.body!, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    const initializer = node.initializer;
    if (
      !initializer ||
      !ts.isCallExpression(initializer) ||
      !ts.isIdentifier(initializer.expression) ||
      initializer.expression.text !== "decodeStorageKey"
    ) {
      return;
    }
    const prefix = initializer.arguments[1];
    if (!prefix || !ts.isStringLiteralLike(prefix)) return;
    const path = itemTemplate(prefix.text);
    if (path) keyedPaths.set(node.name.text, path);
  });

  const operations: Operation[] = [];
  forEachNode(routeFunction.body!, (node) => {
    if (!ts.isIfStatement(node)) return;
    const keyName = guardedIdentifier(node.expression);
    const path = keyName ? keyedPaths.get(keyName) : undefined;
    if (!path) return;
    for (const method of comparedMethods(node.thenStatement, false)) {
      operations.push({ path, method });
    }
  });
  return operations;
}

function browserStoragePaths(
  storageKindFunction: ts.FunctionDeclaration,
): string[] {
  const paths = new Set<string>();
  forEachNode(storageKindFunction.body!, (node) => {
    if (ts.isBinaryExpression(node) && isEquality(node.operatorToken.kind)) {
      const path = comparedString(node, (candidate) =>
        identifier(candidate, "pathname"),
      );
      if (path && isStoragePath(path)) paths.add(path);
      return;
    }
    if (!ts.isCallExpression(node) || node.arguments.length !== 1) return;
    const expression = node.expression;
    if (
      !ts.isPropertyAccessExpression(expression) ||
      expression.name.text !== "startsWith" ||
      !identifier(expression.expression, "pathname")
    ) {
      return;
    }
    const prefix = node.arguments[0];
    if (!ts.isStringLiteralLike(prefix)) return;
    const path = itemTemplate(prefix.text);
    if (path) paths.add(path);
  });
  return [...paths].sort();
}

function comparedMethods(
  node: ts.Node,
  includeNotEqual: boolean,
): HttpMethod[] {
  const methods = new Set<HttpMethod>();
  forEachNode(node, (candidate) => {
    if (!ts.isBinaryExpression(candidate)) return;
    const operator = candidate.operatorToken.kind;
    if (!isEquality(operator) && !(includeNotEqual && isNotEqual(operator))) {
      return;
    }
    const value = comparedString(candidate, (expression) =>
      propertyAccess(expression, "request", "method"),
    );
    const method = value?.toLowerCase();
    if (method && isHttpMethod(method)) methods.add(method);
  });
  return [...methods].sort();
}

function comparedStrings(
  node: ts.Node,
  matches: (candidate: ts.Expression) => boolean,
  includeNotEqual: boolean,
): string[] {
  const values = new Set<string>();
  forEachNode(node, (candidate) => {
    if (!ts.isBinaryExpression(candidate)) return;
    const operator = candidate.operatorToken.kind;
    if (!isEquality(operator) && !(includeNotEqual && isNotEqual(operator))) {
      return;
    }
    const value = comparedString(candidate, matches);
    if (value) values.add(value);
  });
  return [...values];
}

function comparedString(
  expression: ts.BinaryExpression,
  matches: (candidate: ts.Expression) => boolean,
): string | null {
  const left = unwrapExpression(expression.left);
  const right = unwrapExpression(expression.right);
  if (matches(left) && ts.isStringLiteralLike(right)) return right.text;
  if (matches(right) && ts.isStringLiteralLike(left)) return left.text;
  return null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function propertyAccess(
  expression: ts.Expression,
  objectName: string,
  propertyName: string,
): boolean {
  const candidate = unwrapExpression(expression);
  return (
    ts.isPropertyAccessExpression(candidate) &&
    candidate.name.text === propertyName &&
    identifier(candidate.expression, objectName)
  );
}

function identifier(expression: ts.Expression, name: string): boolean {
  const candidate = unwrapExpression(expression);
  return ts.isIdentifier(candidate) && candidate.text === name;
}

function guardedIdentifier(expression: ts.Expression): string | null {
  const candidate = unwrapExpression(expression);
  return ts.isIdentifier(candidate) ? candidate.text : null;
}

function itemTemplate(prefix: string): string | null {
  return prefix.startsWith("/storage/") && prefix.endsWith("/")
    ? `${prefix}{key}`
    : null;
}

function isStoragePath(path: string): boolean {
  return path.startsWith("/storage/") && path !== "/storage/";
}

function isEquality(operator: ts.SyntaxKind): boolean {
  return (
    operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    operator === ts.SyntaxKind.EqualsEqualsToken
  );
}

function isNotEqual(operator: ts.SyntaxKind): boolean {
  return (
    operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    operator === ts.SyntaxKind.ExclamationEqualsToken
  );
}

function forEachNode(node: ts.Node, visitNode: (node: ts.Node) => void): void {
  visitNode(node);
  node.forEachChild((child) => forEachNode(child, visitNode));
}

export function findLegacyLinksLocations(value: unknown): string[] {
  const locations: string[] = [];
  visit(value, "$", locations);
  return locations;
}

export function validateOpenApiSpec(
  document: unknown,
  handlerSource: string,
  storageSources?: StorageRouteSources,
): string[] {
  const errors: string[] = [];
  const spec = asRecord(document);
  if (!spec) return ["OpenAPI document must be an object"];

  if (spec.openapi !== "3.1.0") errors.push("OpenAPI spec must be 3.1.0");
  if (asRecord(spec.info)?.title !== "AittaDB") {
    errors.push("OpenAPI title must match the AittaDB product contract");
  }

  const paths = asRecord(spec.paths);
  if (!paths) return [...errors, "OpenAPI paths must be an object"];

  const implemented = extractImplementedOperations(
    handlerSource,
    storageSources,
  );
  const documented = documentedOperations(paths);
  compareOperationSets(implemented, documented, errors);
  validateOperationResponses(spec, implemented, errors);

  for (const requirement of RESPONSE_REQUIREMENTS) {
    validateResponse(spec, requirement, errors);
  }
  for (const requirement of REQUEST_REQUIREMENTS) {
    validateRequest(spec, requirement, errors);
  }
  validateHypermediaSchemas(spec, errors);

  for (const location of findLegacyLinksLocations(spec.components)) {
    errors.push(`Legacy _links schema member at ${location}`);
  }
  const schemas = asRecord(asRecord(spec.components)?.schemas);
  if (schemas && "HypermediaLinks" in schemas) {
    errors.push("Legacy HypermediaLinks schema must be removed");
  }

  return [...new Set(errors)];
}

function validateOperationResponses(
  spec: UnknownRecord,
  implemented: readonly Operation[],
  errors: string[],
): void {
  for (const candidate of implemented) {
    const operationSpec = getOperation(spec, candidate);
    if (!operationSpec) continue;
    const responses = asRecord(operationSpec.responses);
    if (!responses || Object.keys(responses).length === 0) {
      errors.push(`Missing OpenAPI responses: ${formatOperation(candidate)}`);
    }
  }
}

function compareOperationSets(
  implemented: readonly Operation[],
  documented: readonly Operation[],
  errors: string[],
): void {
  const implementedKeys = new Set(implemented.map(operationKey));
  const documentedKeys = new Set(documented.map(operationKey));
  for (const candidate of implemented) {
    if (!documentedKeys.has(operationKey(candidate))) {
      errors.push(`Missing OpenAPI operation: ${formatOperation(candidate)}`);
    }
  }
  for (const candidate of documented) {
    if (!implementedKeys.has(operationKey(candidate))) {
      errors.push(
        `OpenAPI operation has no handler: ${formatOperation(candidate)}`,
      );
    }
  }
}

function validateResponse(
  spec: UnknownRecord,
  requirement: ResponseRequirement,
  errors: string[],
): void {
  const operationSpec = getOperation(spec, requirement);
  if (!operationSpec) return;
  const responseSpec = asRecord(
    asRecord(operationSpec.responses)?.[requirement.status],
  );
  if (!responseSpec) {
    errors.push(
      `Missing OpenAPI response ${requirement.status}: ${formatOperation(requirement)}`,
    );
    return;
  }
  validateMediaTypes(
    asRecord(responseSpec.content),
    requirement.mediaTypes,
    `${requirement.status} ${formatOperation(requirement)} response`,
    errors,
  );
}

function validateRequest(
  spec: UnknownRecord,
  requirement: RequestRequirement,
  errors: string[],
): void {
  const operationSpec = getOperation(spec, requirement);
  if (!operationSpec) return;
  const requestBody = asRecord(operationSpec.requestBody);
  validateMediaTypes(
    asRecord(requestBody?.content),
    requirement.mediaTypes,
    `${formatOperation(requirement)} request body`,
    errors,
  );
}

function validateMediaTypes(
  content: UnknownRecord | null,
  required: readonly string[],
  context: string,
  errors: string[],
): void {
  for (const mediaType of required) {
    const found = Object.keys(content ?? {}).some(
      (candidate) => normalizeMediaType(candidate) === mediaType,
    );
    if (!found) errors.push(`Missing ${mediaType} for ${context}`);
  }
}

function validateHypermediaSchemas(
  spec: UnknownRecord,
  errors: string[],
): void {
  const schemas = asRecord(asRecord(spec.components)?.schemas);
  const document = asRecord(schemas?.HypermediaDocument);
  const required = Array.isArray(document?.required) ? document.required : [];
  for (const member of ["api_version", "type", "data", "links", "actions"]) {
    if (!required.includes(member)) {
      errors.push(`HypermediaDocument must require ${member}`);
    }
  }
  const properties = asRecord(document?.properties);
  for (const member of ["links", "actions"]) {
    if (asRecord(properties?.[member])?.type !== "array") {
      errors.push(`HypermediaDocument.${member} must be an array`);
    }
  }
}

function getOperation(
  spec: UnknownRecord,
  candidate: Operation,
): UnknownRecord | null {
  const pathItem = asRecord(asRecord(spec.paths)?.[candidate.path]);
  return asRecord(pathItem?.[candidate.method]);
}

function documentedOperations(paths: UnknownRecord): Operation[] {
  const operations: Operation[] = [];
  for (const [path, value] of Object.entries(paths)) {
    const pathItem = asRecord(value);
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      if (method in pathItem) operations.push({ path, method });
    }
  }
  return operations.sort(compareOperations);
}

function visit(value: unknown, path: string, locations: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      visit(entry, `${path}[${index}]`, locations),
    );
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, entry] of Object.entries(record)) {
    const location = `${path}.${key}`;
    if (key === "_links") locations.push(location);
    if (
      key === "required" &&
      Array.isArray(entry) &&
      entry.includes("_links")
    ) {
      locations.push(`${location}[_links]`);
    }
    visit(entry, location, locations);
  }
}

function response(
  path: string,
  method: HttpMethod,
  status: string,
  mediaTypes: readonly string[] = [],
): ResponseRequirement {
  return { path, method, status, mediaTypes };
}

function request(
  path: string,
  method: HttpMethod,
  mediaTypes: readonly string[],
): RequestRequirement {
  return { path, method, mediaTypes };
}

function addOperation(
  operations: Map<string, Operation>,
  candidate: Operation,
): void {
  operations.set(operationKey(candidate), candidate);
}

function normalizeMediaType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function operationKey(candidate: Operation): string {
  return `${candidate.method.toUpperCase()} ${candidate.path}`;
}

function formatOperation(candidate: Operation): string {
  return operationKey(candidate);
}

function compareOperations(left: Operation, right: Operation): number {
  return operationKey(left).localeCompare(operationKey(right));
}

function run(): void {
  const handlerSource = readFileSync(
    new URL("../src/handler.ts", import.meta.url),
    "utf8",
  );
  const storageSources = {
    endpoint: readFileSync(
      new URL("../src/storage.ts", import.meta.url),
      "utf8",
    ),
    browser: readFileSync(
      new URL("../src/storage-browser.ts", import.meta.url),
      "utf8",
    ),
  };
  const errors = validateOpenApiSpec(
    openApiSpec,
    handlerSource,
    storageSources,
  );
  if (errors.length > 0) {
    throw new Error(`OpenAPI validation failed:\n- ${errors.join("\n- ")}`);
  }
  console.log(
    `OpenAPI ${openApiSpec.openapi} documents ${extractImplementedOperations(handlerSource, storageSources).length} implemented operations with representation parity.`,
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === entryPoint) run();
