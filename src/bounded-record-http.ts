import {
  BOUNDED_RECORD_MAX_PAGE_SIZE,
  BOUNDED_RECORD_MAX_TRANSACTION_BYTES,
  BOUNDED_RECORD_MEDIA_TYPE,
  BoundedRecordProtocolError,
  boundedRecordDiscovery,
  boundedRecordDocument,
  boundedRecordErrorDocument,
  boundedRecordErrorStatus,
  boundedRecordPageDocument,
  boundedRecordTransactionDocument,
  decodeBoundedRecordKey,
  decodeBoundedRecordTransaction,
  type BoundedRecord,
  type BoundedRecordErrorCode,
} from "./bounded-record-protocol";
import {
  decodeBoundedRecordCursor,
  encodeBoundedRecordCursor,
} from "./bounded-record-cursor";
import { boundedStorageRecordResult } from "./bounded-record-transaction";
import {
  boundedRecordDiscoveryPage,
  boundedRecordErrorPage,
  boundedRecordItemPage,
  boundedRecordListPage,
  boundedRecordTransactionResultPage,
} from "./bounded-record-pages";
import {
  hasBrowserSession,
  issueBrowserSessionAccessToken,
} from "./browser-session";
import { nowSeconds } from "./crypto";
import {
  acceptsHtml,
  bearerToken,
  csrfCookie,
  csrfTokenForRequest,
  csrfTokenMatches,
  html,
  isJsonMediaType,
  json,
  oauthError,
  readBoundedRequestBody,
  readForm,
  redirect,
} from "./http";
import { HYPERMEDIA_API_VERSION, prefersVendorHypermedia } from "./hypermedia";
import {
  requireSitesIdentity,
  type UpstreamIdentityProvider,
} from "./identity";
import { requireStorageScopes, type StoragePrincipal } from "./storage";
import type { AppConfig, AuthStore } from "./types";

export const BOUNDED_RECORD_ENTRY_PATH = "/storage/record-protocol";
export const BOUNDED_RECORDS_PATH = `${BOUNDED_RECORD_ENTRY_PATH}/records`;
export const BOUNDED_RECORD_TRANSACTIONS_PATH = `${BOUNDED_RECORD_ENTRY_PATH}/transactions`;
export const BOUNDED_RECORD_FORM_MAX_BYTES =
  BOUNDED_RECORD_MAX_TRANSACTION_BYTES * 3 + 4096;

const ITEM_PATH_PREFIX = `${BOUNDED_RECORDS_PATH}/`;
const BROWSER_TRANSACTION_FIELDS = new Set(["csrf_token", "transaction"]);

export function isBoundedRecordRoute(pathname: string): boolean {
  return (
    pathname === BOUNDED_RECORD_ENTRY_PATH ||
    pathname === BOUNDED_RECORDS_PATH ||
    pathname.startsWith(ITEM_PATH_PREFIX) ||
    pathname === BOUNDED_RECORD_TRANSACTIONS_PATH
  );
}

export function isBoundedRecordDiscoveryRoute(pathname: string): boolean {
  return pathname === BOUNDED_RECORD_ENTRY_PATH;
}

export function isBoundedRecordTransactionRoute(pathname: string): boolean {
  return pathname === BOUNDED_RECORD_TRANSACTIONS_PATH;
}

export function boundedRecordProtocolErrorResponse(
  request: Request,
  code: BoundedRecordErrorCode,
): Response {
  return protocolError(request, code);
}

export function boundedRecordDiscoveryEndpoint(
  request: Request,
  config: AppConfig,
  identityProvider: UpstreamIdentityProvider,
  storeAvailable: boolean,
): Response {
  if (request.method !== "GET")
    return protocolError(request, "invalid_request");
  const document = discoveryDocument(config);
  if (!acceptsHtml(request)) return protocolJson(request, document);

  const signedIn =
    storeAvailable && hasBrowserSession(request, identityProvider);
  const csrf = csrfTokenForRequest(request);
  return html(
    boundedRecordDiscoveryPage({
      document,
      ...(signedIn ? { forms: browserForms(csrf) } : {}),
      navigation: {
        homeHref: "/",
        apiDocsHref: "/docs",
        ...(!signedIn ? { signInHref: "/session" } : {}),
      },
    }),
    { headers: { "set-cookie": csrfCookie(csrf) } },
  );
}

export async function boundedRecordHttpEndpoint(
  request: Request,
  url: URL,
  store: AuthStore,
  config: AppConfig,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response | null> {
  if (!isBoundedRecordRoute(url.pathname)) return null;
  if (url.pathname === "/storage/record-protocol" && request.method === "GET") {
    return boundedRecordDiscoveryEndpoint(
      request,
      config,
      identityProvider,
      true,
    );
  }
  if (url.pathname === "/storage/record-protocol") {
    return protocolError(request, "invalid_request");
  }

  try {
    if (
      url.pathname === "/storage/record-protocol/records" &&
      request.method === "GET"
    ) {
      return await listBoundedRecords(
        request,
        url,
        store,
        config,
        identityProvider,
      );
    }
    if (url.pathname === "/storage/record-protocol/records") {
      return protocolError(request, "invalid_request");
    }
    if (
      url.pathname === "/storage/record-protocol/transactions" &&
      request.method === "POST"
    ) {
      return await transactBoundedRecords(
        request,
        store,
        config,
        identityProvider,
      );
    }
    if (url.pathname === "/storage/record-protocol/transactions") {
      return protocolError(request, "invalid_request");
    }
    if (
      url.pathname.startsWith("/storage/record-protocol/records/") &&
      request.method === "GET"
    ) {
      return await readBoundedRecord(
        request,
        url,
        store,
        config,
        identityProvider,
      );
    }
    if (url.pathname.startsWith("/storage/record-protocol/records/")) {
      return protocolError(request, "invalid_request");
    }
    return protocolError(request, "not_found");
  } catch (error) {
    return error instanceof BoundedRecordProtocolError
      ? protocolError(request, error.code)
      : protocolError(request, "unavailable");
  }
}

async function readBoundedRecord(
  request: Request,
  url: URL,
  store: AuthStore,
  config: AppConfig,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response> {
  const key = itemKey(url.pathname);
  const principal = await readPrincipal(
    request,
    store,
    config,
    identityProvider,
  );
  if (principal instanceof Response) return principal;

  const stored = await store.getBoundedStorageRecord(
    principal.userId,
    principal.client.id,
    key.collection,
    key.id,
  );
  if (!stored) return protocolError(request, "not_found");
  const document = boundedRecordDocument(boundedStorageRecordResult(stored));
  if (!acceptsHtml(request)) return protocolJson(request, document);

  const csrf = csrfTokenForRequest(request);
  return html(
    boundedRecordItemPage({
      document,
      collectionHref: collectionHref(config, key.collection),
      forms: browserForms(csrf),
      actions: [
        { href: collectionHref(config, key.collection), label: "Collection" },
        { href: BOUNDED_RECORD_ENTRY_PATH, label: "Protocol", secondary: true },
      ],
    }),
    { headers: { "set-cookie": csrfCookie(csrf) } },
  );
}

async function listBoundedRecords(
  request: Request,
  url: URL,
  store: AuthStore,
  config: AppConfig,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response> {
  if (
    acceptsHtml(request) &&
    !bearerToken(request) &&
    url.searchParams.has("id")
  ) {
    const key = navigationKey(url.searchParams);
    return redirect(
      `${ITEM_PATH_PREFIX}${encodeURIComponent(key.collection)}/${encodeURIComponent(key.id)}`,
      303,
    );
  }

  const query = listQuery(url.searchParams);
  const principal = await readPrincipal(
    request,
    store,
    config,
    identityProvider,
  );
  if (principal instanceof Response) return principal;

  const position = query.cursor
    ? await decodeBoundedRecordCursor(
        query.cursor,
        principal.userId,
        principal.client.id,
        query.collection,
        query.limit,
        config,
      )
    : { afterId: null };
  if (!position) return protocolError(request, "invalid_request");

  const page = await store.listBoundedStorageRecords(
    principal.userId,
    principal.client.id,
    query.collection,
    position.afterId,
    query.limit,
  );
  const records = page.items.map(boundedStorageRecordResult);
  const last = records.at(-1);
  if (page.hasMore && !last) return protocolError(request, "unavailable");
  const nextCursor =
    page.hasMore && last
      ? await encodeBoundedRecordCursor(
          principal.userId,
          principal.client.id,
          query.collection,
          query.limit,
          last.key.id,
          config,
        )
      : null;
  const href = collectionHref(
    config,
    query.collection,
    query.limit,
    query.cursor,
  );
  const nextHref = nextCursor
    ? collectionHref(config, query.collection, query.limit, nextCursor)
    : null;
  const document = boundedRecordPageDocument({
    href,
    collection: query.collection,
    pageSize: query.limit,
    items: records,
    nextCursor,
    nextHref,
  });
  if (!acceptsHtml(request)) return protocolJson(request, document);

  const csrf = csrfTokenForRequest(request);
  return html(
    boundedRecordListPage({
      document,
      recordHref: recordHref,
      forms: browserForms(csrf),
      actions: [
        { href: BOUNDED_RECORD_ENTRY_PATH, label: "Protocol" },
        { href: "/docs", label: "API docs", secondary: true },
      ],
    }),
    { headers: { "set-cookie": csrfCookie(csrf) } },
  );
}

async function transactBoundedRecords(
  request: Request,
  store: AuthStore,
  config: AppConfig,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response> {
  const browserForm = isBrowserTransaction(request);
  const principal = browserForm
    ? null
    : await requireStorageScopes(
        request,
        config,
        store,
        ["storage.read", "storage.write", "storage.delete"],
        false,
      );
  if (principal instanceof Response) return principal;
  const command = browserForm
    ? await browserTransaction(request)
    : await canonicalTransaction(request);
  if (command instanceof Response) return command;
  const authorized =
    principal ??
    (await browserTransactionPrincipal(
      request,
      store,
      config,
      identityProvider,
    ));
  if (authorized instanceof Response) return authorized;

  const result = await store.transactBoundedStorageRecords(
    authorized.userId,
    authorized.client.id,
    command,
    config.storageLimits,
    nowSeconds(),
    {
      receiptRetentionSeconds: config.boundedRecordReceiptRetentionSeconds,
      receiptLimits: config.boundedRecordReceiptLimits,
    },
  );
  let document;
  switch (result.status) {
    case "conflict":
      return protocolError(request, "conflict");
    case "precondition_failed":
      return protocolError(request, "precondition_failed");
    case "quota_exceeded":
      return protocolError(request, "quota_exceeded");
    case "unavailable":
      return protocolError(request, "unavailable");
    case "created":
    case "replayed":
      document = boundedRecordTransactionDocument({
        operationId: command.transaction.operation_id,
        replayed: result.status === "replayed",
        records: result.records,
      });
      break;
  }
  if (!acceptsHtml(request)) return protocolJson(request, document);
  return html(
    boundedRecordTransactionResultPage({
      document,
      recordHref,
      actions: [
        { href: BOUNDED_RECORD_ENTRY_PATH, label: "Run another transaction" },
        { href: "/docs", label: "API docs", secondary: true },
      ],
    }),
  );
}

async function readPrincipal(
  request: Request,
  store: AuthStore,
  config: AppConfig,
  identityProvider: UpstreamIdentityProvider,
): Promise<StoragePrincipal | Response> {
  if (bearerToken(request)) {
    return requireStorageScopes(
      request,
      config,
      store,
      ["storage.read"],
      false,
    );
  }
  if (!hasBrowserSession(request, identityProvider)) {
    return acceptsHtml(request)
      ? (requireSitesIdentity(request, identityProvider) as Response)
      : oauthError("invalid_token", "Bearer token required", 401);
  }
  const token = await issueBrowserSessionAccessToken(
    request,
    identityProvider,
    store,
    config,
    ["storage.read"],
  );
  if (token instanceof Response) return token;
  return requireStorageScopes(
    requestWithBearer(request, token),
    config,
    store,
    ["storage.read"],
    false,
  );
}

async function browserTransactionPrincipal(
  request: Request,
  store: AuthStore,
  config: AppConfig,
  identityProvider: UpstreamIdentityProvider,
): Promise<StoragePrincipal | Response> {
  if (bearerToken(request)) return protocolError(request, "invalid_request");
  if (!hasBrowserSession(request, identityProvider)) {
    return requireSitesIdentity(request, identityProvider) as Response;
  }
  const token = await issueBrowserSessionAccessToken(
    request,
    identityProvider,
    store,
    config,
    ["storage.read", "storage.write", "storage.delete"],
  );
  if (token instanceof Response) return token;
  return requireStorageScopes(
    requestWithBearer(request, token),
    config,
    store,
    ["storage.read", "storage.write", "storage.delete"],
    false,
  );
}

async function canonicalTransaction(
  request: Request,
): Promise<ReturnType<typeof decodeBoundedRecordTransaction> | Response> {
  if (!isJsonMediaType(request.headers.get("content-type") ?? "")) {
    return protocolError(request, "invalid_request");
  }
  try {
    const body = await readBoundedRequestBody(
      request,
      BOUNDED_RECORD_MAX_TRANSACTION_BYTES,
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return decodeBoundedRecordTransaction(JSON.parse(text) as unknown);
  } catch (error) {
    return error instanceof BoundedRecordProtocolError
      ? protocolError(request, error.code)
      : protocolError(request, "invalid_request");
  }
}

async function browserTransaction(
  request: Request,
): Promise<ReturnType<typeof decodeBoundedRecordTransaction> | Response> {
  let form: URLSearchParams;
  try {
    form = await readForm(request, BOUNDED_RECORD_FORM_MAX_BYTES);
  } catch {
    return protocolError(request, "invalid_request");
  }
  if (!hasExactFormFields(form, BROWSER_TRANSACTION_FIELDS)) {
    return protocolError(request, "invalid_request");
  }
  if (!csrfTokenMatches(request, form.get("csrf_token"))) {
    return html(
      boundedRecordErrorPage({
        code: "invalid_request",
        status: 403,
        actions: [
          { href: BOUNDED_RECORD_ENTRY_PATH, label: "Return to protocol" },
        ],
      }),
      { status: 403 },
    );
  }
  try {
    return decodeBoundedRecordTransaction(
      JSON.parse(form.get("transaction") ?? "") as unknown,
    );
  } catch (error) {
    return error instanceof BoundedRecordProtocolError
      ? protocolError(request, error.code)
      : protocolError(request, "invalid_request");
  }
}

function protocolError(
  request: Request,
  code: BoundedRecordErrorCode,
): Response {
  const status = boundedRecordErrorStatus(code);
  if (acceptsHtml(request)) {
    return html(
      boundedRecordErrorPage({
        code,
        actions: [
          { href: BOUNDED_RECORD_ENTRY_PATH, label: "Record protocol" },
          { href: "/docs", label: "API docs", secondary: true },
        ],
      }),
      { status },
    );
  }
  return protocolJson(request, boundedRecordErrorDocument(code), { status });
}

function protocolJson(
  request: Request,
  document: unknown,
  init: ResponseInit = {},
): Response {
  const response = json(document, init);
  response.headers.set(
    "content-type",
    prefersVendorHypermedia(request)
      ? BOUNDED_RECORD_MEDIA_TYPE
      : "application/json; charset=utf-8",
  );
  response.headers.set("aittadb-api-version", HYPERMEDIA_API_VERSION);
  response.headers.set("vary", "Accept");
  return response;
}

function discoveryDocument(config: AppConfig) {
  return boundedRecordDiscovery({
    entryHref: `${config.issuerUrl}${BOUNDED_RECORD_ENTRY_PATH}`,
    readRecordHref: `${config.issuerUrl}${BOUNDED_RECORDS_PATH}/{collection}/{id}`,
    listRecordsHref: `${config.issuerUrl}${BOUNDED_RECORDS_PATH}`,
    transactRecordsHref: `${config.issuerUrl}${BOUNDED_RECORD_TRANSACTIONS_PATH}`,
  });
}

function itemKey(pathname: string) {
  const remainder = pathname.slice(ITEM_PATH_PREFIX.length);
  const parts = remainder.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new BoundedRecordProtocolError("invalid_request");
  }
  try {
    return decodeBoundedRecordKey({
      collection: decodeURIComponent(parts[0]!),
      id: decodeURIComponent(parts[1]!),
    });
  } catch (error) {
    if (error instanceof BoundedRecordProtocolError) throw error;
    throw new BoundedRecordProtocolError("invalid_request");
  }
}

function navigationKey(params: URLSearchParams) {
  if (!hasExactQueryFields(params, ["collection", "id"])) {
    throw new BoundedRecordProtocolError("invalid_request");
  }
  return decodeBoundedRecordKey({
    collection: params.get("collection"),
    id: params.get("id"),
  });
}

function listQuery(params: URLSearchParams): {
  collection: string;
  limit: number;
  cursor: string | null;
} {
  const allowed = params.has("cursor")
    ? ["collection", "limit", "cursor"]
    : ["collection", "limit"];
  if (!hasExactQueryFields(params, allowed)) {
    throw new BoundedRecordProtocolError("invalid_request");
  }
  const collection = decodeBoundedRecordKey({
    collection: params.get("collection"),
    id: "list-boundary",
  }).collection;
  const rawLimit = params.get("limit") ?? "";
  if (!/^[1-9][0-9]*$/.test(rawLimit)) {
    throw new BoundedRecordProtocolError("invalid_request");
  }
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit > BOUNDED_RECORD_MAX_PAGE_SIZE) {
    throw new BoundedRecordProtocolError("invalid_request");
  }
  const cursor = params.get("cursor");
  if (cursor !== null && cursor.length === 0) {
    throw new BoundedRecordProtocolError("invalid_request");
  }
  return { collection, limit, cursor };
}

function hasExactQueryFields(
  params: URLSearchParams,
  expected: readonly string[],
): boolean {
  const entries = [...params.keys()];
  return (
    entries.length === expected.length &&
    expected.every(
      (name) => entries.filter((entry) => entry === name).length === 1,
    )
  );
}

function hasExactFormFields(
  form: URLSearchParams,
  expected: ReadonlySet<string>,
): boolean {
  const entries = [...form.keys()];
  return (
    entries.length === expected.size &&
    entries.every((name) => expected.has(name)) &&
    [...expected].every(
      (name) => entries.filter((entry) => entry === name).length === 1,
    )
  );
}

function collectionHref(
  config: AppConfig,
  collection: string,
  limit = BOUNDED_RECORD_MAX_PAGE_SIZE,
  cursor: string | null = null,
): string {
  const href = new URL(BOUNDED_RECORDS_PATH, config.issuerUrl);
  href.searchParams.set("collection", collection);
  href.searchParams.set("limit", String(limit));
  if (cursor) href.searchParams.set("cursor", cursor);
  return href.toString();
}

function recordHref(record: Readonly<BoundedRecord>): string {
  return `${ITEM_PATH_PREFIX}${encodeURIComponent(record.key.collection)}/${encodeURIComponent(record.key.id)}`;
}

function browserForms(csrfToken: string) {
  return {
    readAction: BOUNDED_RECORDS_PATH,
    listAction: BOUNDED_RECORDS_PATH,
    transactionAction: BOUNDED_RECORD_TRANSACTIONS_PATH,
    csrfToken,
  };
}

function requestWithBearer(request: Request, token: string): Request {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", BOUNDED_RECORD_MEDIA_TYPE);
  return new Request(request.url, { method: request.method, headers });
}

function isBrowserTransaction(request: Request): boolean {
  return (request.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("application/x-www-form-urlencoded");
}
