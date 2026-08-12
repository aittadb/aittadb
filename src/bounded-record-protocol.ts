import { HYPERMEDIA_API_VERSION, HYPERMEDIA_MEDIA_TYPE } from "./hypermedia";

export const BOUNDED_RECORD_PROTOCOL_VERSION = "1.1";
export const BOUNDED_RECORD_MEDIA_TYPE =
  `${HYPERMEDIA_MEDIA_TYPE}; version=${HYPERMEDIA_API_VERSION}` as const;
export const BOUNDED_RECORD_MAX_PAGE_SIZE = 100;
export const BOUNDED_RECORD_MAX_TRANSACTION_ENTRIES = 25;
export const BOUNDED_RECORD_MAX_RECORD_BYTES = 65_536;
export const BOUNDED_RECORD_MAX_TRANSACTION_BYTES = 1_048_576;
export const BOUNDED_RECORD_MAX_CURSOR_LENGTH = 2_048;

const STABLE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/;
const COLLECTION_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_STABLE_ID_LENGTH = 128;
const MAX_JSON_NODES = 65_536;

export const BOUNDED_RECORD_CAPABILITIES = Object.freeze([
  "bounded-record-read",
  "opaque-cursor-page",
  "atomic-multi-record-compare-and-set",
  "atomic-read-revision-check",
  "idempotent-operation-id",
  "atomic-rollback",
  "quota-preflight",
  "non-disclosing-authorization",
] as const);

export interface BoundedRecordLimits {
  max_record_bytes: number;
  max_page_size: number;
  max_transaction_mutations: number;
  max_transaction_bytes: number;
  max_cursor_length: number;
}

export const BOUNDED_RECORD_LIMITS: Readonly<BoundedRecordLimits> =
  Object.freeze({
    max_record_bytes: BOUNDED_RECORD_MAX_RECORD_BYTES,
    max_page_size: BOUNDED_RECORD_MAX_PAGE_SIZE,
    max_transaction_mutations: BOUNDED_RECORD_MAX_TRANSACTION_ENTRIES,
    max_transaction_bytes: BOUNDED_RECORD_MAX_TRANSACTION_BYTES,
    max_cursor_length: BOUNDED_RECORD_MAX_CURSOR_LENGTH,
  });

export type BoundedJsonPrimitive = string | number | boolean | null;
export type BoundedJsonValue =
  | BoundedJsonPrimitive
  | readonly BoundedJsonValue[]
  | Readonly<{ [key: string]: BoundedJsonValue }>;
export type BoundedRecordValue = Readonly<{
  [key: string]: BoundedJsonValue;
}>;

export interface BoundedRecordKey {
  collection: string;
  id: string;
}

export interface BoundedRecord {
  key: Readonly<BoundedRecordKey>;
  revision: number;
  value: BoundedRecordValue;
}

export type BoundedRecordMutation =
  | Readonly<{
      type: "put";
      key: Readonly<BoundedRecordKey>;
      expected_revision: number | null;
      value: BoundedRecordValue;
    }>
  | Readonly<{
      type: "delete";
      key: Readonly<BoundedRecordKey>;
      expected_revision: number;
    }>
  | Readonly<{
      type: "check";
      key: Readonly<BoundedRecordKey>;
      expected_revision: number | null;
    }>;

export interface BoundedRecordTransaction {
  operation_id: string;
  mutations: readonly BoundedRecordMutation[];
}

export interface BoundedRecordTransactionCommand {
  transaction: Readonly<BoundedRecordTransaction>;
}

export interface BoundedRecordLink {
  rel: readonly string[];
  href: string;
  type: typeof BOUNDED_RECORD_MEDIA_TYPE;
  templated?: boolean;
}

export interface BoundedRecordField {
  name: string;
  title: string;
  type: "string" | "integer" | "object";
  location: "path" | "query" | "body";
  required: boolean;
  min?: number;
  max?: number;
  min_length?: number;
  max_length?: number;
  max_bytes?: number;
  description?: string;
}

export interface BoundedRecordAction {
  name: "read-record" | "list-records" | "transact-records";
  title: string;
  method: "GET" | "POST";
  href: string;
  type?: "application/json";
  accept: typeof BOUNDED_RECORD_MEDIA_TYPE;
  templated?: boolean;
  authorization: Readonly<{
    scheme: "bearer";
    scopes: readonly ("storage.read" | "storage.write" | "storage.delete")[];
  }>;
  fields: readonly BoundedRecordField[];
}

export interface BoundedRecordDiscoveryDocument {
  api_version: typeof HYPERMEDIA_API_VERSION;
  type: "bounded-record-storage";
  id: string;
  data: Readonly<{
    protocol: "bounded-record-storage";
    protocol_version: typeof BOUNDED_RECORD_PROTOCOL_VERSION;
    capabilities: typeof BOUNDED_RECORD_CAPABILITIES;
    limits: Readonly<BoundedRecordLimits>;
    preconditions: "compare-and-set-revision";
    idempotency: "canonical-request-per-operation-id";
    rollback: "all-mutations-and-operation-receipt";
    quota: "reject-before-commit";
    authorization: "missing-and-denied-are-not-found";
    pagination: "opaque-cursor-with-next-link";
    transaction_shape: Readonly<{
      operation_id: Readonly<{
        format: "stable-id";
        min_length: 1;
        max_length: 128;
      }>;
      mutations: Readonly<{
        min_items: 1;
        max_items: 25;
        unique_keys: true;
        order: "preserved";
        put: "null-creates-positive-revision-replaces";
        delete: "positive-revision-required";
        check: "null-requires-absence-positive-revision-preserves-record";
      }>;
      results: "ordered-record-or-null-per-mutation";
    }>;
  }>;
  links: readonly BoundedRecordLink[];
  actions: readonly BoundedRecordAction[];
}

export interface BoundedRecordDocument {
  api_version: typeof HYPERMEDIA_API_VERSION;
  type: "bounded-storage-record";
  id: string;
  data: Readonly<BoundedRecord>;
  links: readonly BoundedRecordLink[];
  actions: readonly BoundedRecordAction[];
}

export interface BoundedRecordPageDocument {
  api_version: typeof HYPERMEDIA_API_VERSION;
  type: "bounded-storage-records-page";
  id: string;
  data: Readonly<{
    collection: string;
    page_size: number;
    items: readonly Readonly<BoundedRecord>[];
    next_cursor: string | null;
  }>;
  links: readonly BoundedRecordLink[];
  actions: readonly BoundedRecordAction[];
}

export interface BoundedRecordTransactionDocument {
  api_version: typeof HYPERMEDIA_API_VERSION;
  type: "bounded-storage-transaction";
  id: string;
  data: Readonly<{
    operation_id: string;
    replayed: boolean;
    records: readonly (Readonly<BoundedRecord> | null)[];
  }>;
  links: readonly BoundedRecordLink[];
  actions: readonly BoundedRecordAction[];
}

export type BoundedRecordErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "precondition_failed"
  | "quota_exceeded"
  | "unavailable";

export interface BoundedRecordErrorDocument {
  api_version: typeof HYPERMEDIA_API_VERSION;
  type: "bounded-storage-error";
  data: Readonly<{ code: BoundedRecordErrorCode; message: string }>;
  links: readonly [];
  actions: readonly [];
}

const ERROR_STATUS = Object.freeze({
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  quota_exceeded: 507,
  unavailable: 503,
} as const satisfies Readonly<Record<BoundedRecordErrorCode, number>>);

const ERROR_MESSAGE = Object.freeze({
  invalid_request: "The storage request is invalid.",
  not_found: "The storage resource was not found.",
  conflict: "The storage request conflicts with current state.",
  precondition_failed: "The storage resource has changed.",
  quota_exceeded: "The storage quota would be exceeded.",
  unavailable: "Storage is temporarily unavailable.",
} as const satisfies Readonly<Record<BoundedRecordErrorCode, string>>);

export class BoundedRecordProtocolError extends Error {
  readonly code: BoundedRecordErrorCode;

  constructor(code: BoundedRecordErrorCode) {
    super(ERROR_MESSAGE[code]);
    this.name = "BoundedRecordProtocolError";
    this.code = code;
  }
}

export function boundedRecordDiscovery(input: {
  entryHref: string;
  readRecordHref: string;
  listRecordsHref: string;
  transactRecordsHref: string;
  limits?: Readonly<BoundedRecordLimits>;
}): BoundedRecordDiscoveryDocument {
  const entry = exactHttpsUrl(input.entryHref);
  const list = exactHttpsUrl(input.listRecordsHref);
  const transaction = exactHttpsUrl(input.transactRecordsHref);
  const readOrigin = templatedReadOrigin(input.readRecordHref);
  if (
    list.origin !== entry.origin ||
    transaction.origin !== entry.origin ||
    readOrigin !== entry.origin
  ) {
    invalidRequest();
  }
  const limits = validateBoundedRecordLimits(
    input.limits ?? BOUNDED_RECORD_LIMITS,
  );
  return deepFreeze({
    api_version: HYPERMEDIA_API_VERSION,
    type: "bounded-record-storage",
    id: entry.href,
    data: {
      protocol: "bounded-record-storage",
      protocol_version: BOUNDED_RECORD_PROTOCOL_VERSION,
      capabilities: BOUNDED_RECORD_CAPABILITIES,
      limits,
      preconditions: "compare-and-set-revision",
      idempotency: "canonical-request-per-operation-id",
      rollback: "all-mutations-and-operation-receipt",
      quota: "reject-before-commit",
      authorization: "missing-and-denied-are-not-found",
      pagination: "opaque-cursor-with-next-link",
      transaction_shape: {
        operation_id: {
          format: "stable-id",
          min_length: 1,
          max_length: MAX_STABLE_ID_LENGTH,
        },
        mutations: {
          min_items: 1,
          max_items: BOUNDED_RECORD_MAX_TRANSACTION_ENTRIES,
          unique_keys: true,
          order: "preserved",
          put: "null-creates-positive-revision-replaces",
          delete: "positive-revision-required",
          check: "null-requires-absence-positive-revision-preserves-record",
        },
        results: "ordered-record-or-null-per-mutation",
      },
    },
    links: [
      protocolLink("self", entry.href),
      protocolLink("records", list.href),
    ],
    actions: [
      {
        name: "read-record",
        title: "Read record",
        method: "GET",
        href: input.readRecordHref,
        accept: BOUNDED_RECORD_MEDIA_TYPE,
        templated: true,
        authorization: { scheme: "bearer", scopes: ["storage.read"] },
        fields: [
          textField("collection", "Collection", "path", true, 1, 64),
          textField("id", "Record ID", "path", true, 1, 128),
        ],
      },
      {
        name: "list-records",
        title: "List records",
        method: "GET",
        href: list.href,
        accept: BOUNDED_RECORD_MEDIA_TYPE,
        authorization: { scheme: "bearer", scopes: ["storage.read"] },
        fields: [
          textField("collection", "Collection", "query", true, 1, 64),
          {
            name: "limit",
            title: "Page size",
            type: "integer",
            location: "query",
            required: true,
            min: 1,
            max: BOUNDED_RECORD_MAX_PAGE_SIZE,
          },
          textField(
            "cursor",
            "Opaque continuation cursor",
            "query",
            false,
            1,
            limits.max_cursor_length,
          ),
        ],
      },
      {
        name: "transact-records",
        title: "Apply record transaction",
        method: "POST",
        href: transaction.href,
        type: "application/json",
        accept: BOUNDED_RECORD_MEDIA_TYPE,
        authorization: {
          scheme: "bearer",
          scopes: ["storage.read", "storage.write", "storage.delete"],
        },
        fields: [
          {
            name: "transaction",
            title: "Atomic transaction",
            type: "object",
            location: "body",
            required: true,
            max_bytes: limits.max_transaction_bytes,
            description:
              "One operation_id and an ordered mutations array of compare-and-set put, delete, or non-mutating check entries.",
          },
        ],
      },
    ],
  });
}

export function decodeBoundedRecordTransaction(
  value: unknown,
  limits: Readonly<BoundedRecordLimits> = BOUNDED_RECORD_LIMITS,
): Readonly<BoundedRecordTransactionCommand> {
  const acceptedLimits = validateBoundedRecordLimits(limits);
  const command = exactDataObject(value, ["transaction"]);
  const wireTransaction = exactDataObject(command.transaction, [
    "operation_id",
    "mutations",
  ]);
  const operationId = stableId(wireTransaction.operation_id);
  const candidates = exactDataArray(wireTransaction.mutations);
  if (
    candidates.length < 1 ||
    candidates.length > acceptedLimits.max_transaction_mutations
  ) {
    invalidRequest();
  }

  const seen = new Set<string>();
  const mutations: BoundedRecordMutation[] = [];
  for (const candidate of candidates) {
    const typeSource = dataObject(candidate);
    const type = dataMember(typeSource, "type");
    if (type !== "put" && type !== "delete" && type !== "check") {
      invalidRequest();
    }
    const mutation = exactDataObject(
      candidate,
      type === "put"
        ? ["type", "key", "expected_revision", "value"]
        : ["type", "key", "expected_revision"],
    );
    const key = decodeBoundedRecordKey(mutation.key);
    const identity = canonicalJson(key);
    if (seen.has(identity)) invalidRequest();
    seen.add(identity);
    const expectedRevision = nullablePositiveRevision(
      mutation.expected_revision,
    );
    if (type === "delete" && expectedRevision === null) invalidRequest();

    if (type === "put") {
      const recordValue = snapshotRecordValue(mutation.value);
      if (jsonBytes(recordValue) > acceptedLimits.max_record_bytes) {
        invalidRequest();
      }
      mutations.push(
        deepFreeze({
          type,
          key,
          expected_revision: expectedRevision,
          value: recordValue,
        }),
      );
    } else if (type === "delete") {
      mutations.push(
        deepFreeze({
          type,
          key,
          expected_revision: expectedRevision as number,
        }),
      );
    } else {
      mutations.push(
        deepFreeze({
          type,
          key,
          expected_revision: expectedRevision,
        }),
      );
    }
  }

  const snapshot = deepFreeze({
    transaction: {
      operation_id: operationId,
      mutations,
    },
  });
  if (jsonBytes(snapshot) > acceptedLimits.max_transaction_bytes) {
    invalidRequest();
  }
  return snapshot;
}

export function decodeBoundedRecordKey(
  value: unknown,
): Readonly<BoundedRecordKey> {
  const key = exactDataObject(value, ["collection", "id"]);
  if (
    typeof key.collection !== "string" ||
    !COLLECTION_PATTERN.test(key.collection)
  ) {
    invalidRequest();
  }
  return deepFreeze({
    collection: key.collection,
    id: stableId(key.id),
  });
}

export function canonicalBoundedRecordTransaction(command: unknown): string {
  return canonicalJson(decodeBoundedRecordTransaction(command));
}

export function boundedRecordDocument(
  record: Readonly<BoundedRecord>,
): BoundedRecordDocument {
  const snapshot = snapshotRecord(record);
  return deepFreeze({
    api_version: HYPERMEDIA_API_VERSION,
    type: "bounded-storage-record",
    id: `${snapshot.key.collection}/${snapshot.key.id}`,
    data: snapshot,
    links: [],
    actions: [],
  });
}

export function boundedRecordPageDocument(input: {
  href: string;
  collection: string;
  pageSize: number;
  items: readonly Readonly<BoundedRecord>[];
  nextCursor: string | null;
  nextHref: string | null;
}): BoundedRecordPageDocument {
  const href = exactHttpsUrl(input.href).href;
  const collection = decodeBoundedRecordKey({
    collection: input.collection,
    id: "cursor-boundary",
  }).collection;
  if (
    !Number.isSafeInteger(input.pageSize) ||
    input.pageSize < 1 ||
    input.pageSize > BOUNDED_RECORD_MAX_PAGE_SIZE ||
    input.items.length > input.pageSize ||
    (input.nextCursor === null) !== (input.nextHref === null) ||
    (input.nextCursor !== null &&
      (input.nextCursor.length < 1 ||
        input.nextCursor.length > BOUNDED_RECORD_MAX_CURSOR_LENGTH))
  ) {
    invalidRequest();
  }
  const items = input.items.map((record) => snapshotRecord(record));
  let previousId: string | null = null;
  for (const record of items) {
    if (
      record.key.collection !== collection ||
      (previousId !== null && previousId >= record.key.id)
    ) {
      invalidRequest();
    }
    previousId = record.key.id;
  }
  const links: BoundedRecordLink[] = [protocolLink("self", href)];
  if (input.nextHref !== null) {
    const next = exactHttpsUrl(input.nextHref);
    if (next.origin !== new URL(href).origin || items.length === 0) {
      invalidRequest();
    }
    links.push(protocolLink("next", next.href));
  }
  return deepFreeze({
    api_version: HYPERMEDIA_API_VERSION,
    type: "bounded-storage-records-page",
    id: href,
    data: {
      collection,
      page_size: input.pageSize,
      items,
      next_cursor: input.nextCursor,
    },
    links,
    actions: [],
  });
}

export function boundedRecordTransactionDocument(input: {
  operationId: string;
  replayed: boolean;
  records: readonly (Readonly<BoundedRecord> | null)[];
}): BoundedRecordTransactionDocument {
  const operationId = stableId(input.operationId);
  return deepFreeze({
    api_version: HYPERMEDIA_API_VERSION,
    type: "bounded-storage-transaction",
    id: operationId,
    data: {
      operation_id: operationId,
      replayed: input.replayed,
      records: input.records.map((record) =>
        record === null ? null : snapshotRecord(record),
      ),
    },
    links: [],
    actions: [],
  });
}

export function boundedRecordErrorDocument(
  code: BoundedRecordErrorCode,
): BoundedRecordErrorDocument {
  return deepFreeze({
    api_version: HYPERMEDIA_API_VERSION,
    type: "bounded-storage-error",
    data: { code, message: ERROR_MESSAGE[code] },
    links: [],
    actions: [],
  });
}

export function boundedRecordErrorStatus(code: BoundedRecordErrorCode): number {
  return ERROR_STATUS[code];
}

export function validateBoundedRecordLimits(
  limits: Readonly<BoundedRecordLimits>,
): Readonly<BoundedRecordLimits> {
  if (
    !boundedInteger(
      limits.max_record_bytes,
      1,
      BOUNDED_RECORD_MAX_RECORD_BYTES,
    ) ||
    limits.max_page_size !== BOUNDED_RECORD_MAX_PAGE_SIZE ||
    limits.max_transaction_mutations !==
      BOUNDED_RECORD_MAX_TRANSACTION_ENTRIES ||
    !boundedInteger(
      limits.max_transaction_bytes,
      1,
      BOUNDED_RECORD_MAX_TRANSACTION_BYTES,
    ) ||
    !boundedInteger(
      limits.max_cursor_length,
      1,
      BOUNDED_RECORD_MAX_CURSOR_LENGTH,
    )
  ) {
    invalidRequest();
  }
  return Object.freeze({ ...limits });
}

function snapshotRecord(
  record: Readonly<BoundedRecord>,
): Readonly<BoundedRecord> {
  const key = decodeBoundedRecordKey(record.key);
  if (!isPositiveRevision(record.revision)) invalidRequest();
  const value = snapshotRecordValue(record.value);
  if (jsonBytes(value) > BOUNDED_RECORD_MAX_RECORD_BYTES) invalidRequest();
  return deepFreeze({ key, revision: record.revision, value });
}

function snapshotRecordValue(value: unknown): BoundedRecordValue {
  const state = { seen: new WeakSet<object>(), nodes: 0 };
  const snapshot = snapshotJsonValue(value, state);
  if (!isPlainDataObject(snapshot)) invalidRequest();
  return snapshot as BoundedRecordValue;
}

function snapshotJsonValue(
  value: unknown,
  state: { seen: WeakSet<object>; nodes: number },
): BoundedJsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) invalidRequest();
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidRequest();
    return value;
  }
  if (typeof value !== "object") invalidRequest();
  if (state.seen.has(value)) invalidRequest();
  state.seen.add(value);
  if (Array.isArray(value)) {
    const source = exactDataArray(value);
    return Object.freeze(
      source.map((entry) => snapshotJsonValue(entry, state)),
    );
  }
  const source = dataObject(value);
  const snapshot: Record<string, BoundedJsonValue> = {};
  for (const [key, member] of dataEntries(source)) {
    Object.defineProperty(snapshot, key, {
      value: snapshotJsonValue(member, state),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

function stableId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_STABLE_ID_LENGTH ||
    !STABLE_ID_PATTERN.test(value)
  ) {
    invalidRequest();
  }
  return value;
}

function nullablePositiveRevision(value: unknown): number | null {
  if (value === null) return null;
  if (!isPositiveRevision(value)) invalidRequest();
  return value;
}

function isPositiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function boundedInteger(value: unknown, minimum: number, maximum: number) {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum
  );
}

function dataObject(value: unknown): Record<string, unknown> {
  if (!isPlainDataObject(value)) invalidRequest();
  return value;
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataEntries(value: Record<string, unknown>): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalidRequest();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      invalidRequest();
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function dataMember(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !("value" in descriptor)
  ) {
    invalidRequest();
  }
  return descriptor.value;
}

function exactDataObject(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const source = dataObject(value);
  const entries = dataEntries(source);
  const actual = entries.map(([key]) => key).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalidRequest();
  }
  return Object.fromEntries(entries) as Record<string, unknown>;
}

function exactDataArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalidRequest();
  const extraKeys = Reflect.ownKeys(value).filter((key) => {
    if (key === "length") return false;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return true;
    const index = Number(key);
    return !Number.isSafeInteger(index) || index < 0 || index >= value.length;
  });
  if (extraKeys.length !== 0) invalidRequest();
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      invalidRequest();
    }
    copy.push(descriptor.value);
  }
  return copy;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (!isPlainDataObject(value)) return value;
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, member] of dataEntries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    result[key] = canonicalValue(member);
  }
  return result;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

function exactHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidRequest();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    invalidRequest();
  }
  return url;
}

function templatedReadOrigin(value: string): string {
  if (
    occurrences(value, "{collection}") !== 1 ||
    occurrences(value, "{id}") !== 1
  ) {
    invalidRequest();
  }
  const resolved = value
    .replace("{collection}", "collection")
    .replace("{id}", "record-id");
  const url = exactHttpsUrl(resolved);
  if (url.search !== "") invalidRequest();
  return url.origin;
}

function occurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

function protocolLink(relation: string, href: string): BoundedRecordLink {
  return { rel: [relation], href, type: BOUNDED_RECORD_MEDIA_TYPE };
}

function textField(
  name: string,
  title: string,
  location: "path" | "query",
  required: boolean,
  minLength: number,
  maxLength: number,
): BoundedRecordField {
  return {
    name,
    title,
    type: "string",
    location,
    required,
    min_length: minLength,
    max_length: maxLength,
  };
}

function invalidRequest(): never {
  throw new BoundedRecordProtocolError("invalid_request");
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const member of Object.values(value as Record<string, unknown>)) {
    deepFreeze(member);
  }
  return Object.freeze(value);
}
