import {
  BOUNDED_RECORD_MAX_RECORD_BYTES,
  BOUNDED_RECORD_MAX_TRANSACTION_ENTRIES,
  boundedRecordDocument,
  boundedRecordTransactionDocument,
  canonicalBoundedRecordTransaction,
  decodeBoundedRecordKey,
  decodeBoundedRecordTransaction,
} from "./bounded-record-protocol";
import type {
  BoundedJsonValue,
  BoundedRecord,
  BoundedRecordTransactionCommand,
  BoundedRecordValue,
} from "./bounded-record-protocol";
import { randomToken, sha256 } from "./crypto";
import type {
  BoundedStorageReceiptLimits,
  BoundedStorageRecord,
  StorageLimits,
} from "./types";

const RESULT_ENVELOPE_BYTES = 65_536;
const NAMESPACE_PART_MAX_LENGTH = 240;

export const BOUNDED_RECORD_RECEIPT_DEFAULT_RETENTION_SECONDS = 24 * 60 * 60;
export const BOUNDED_RECORD_RECEIPT_MIN_RETENTION_SECONDS = 60;
export const BOUNDED_RECORD_RECEIPT_MAX_RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const BOUNDED_RECORD_RECEIPT_DEFAULT_LIMITS = Object.freeze({
  globalMaxItems: 10_000,
  globalMaxBytes: 1024 * 1024 * 1024,
  userMaxItems: 1_000,
  userMaxBytes: 100 * 1024 * 1024,
  namespaceMaxItems: 500,
  namespaceMaxBytes: 50 * 1024 * 1024,
}) satisfies Readonly<BoundedStorageReceiptLimits>;

export const BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD = 6;

export type BoundedStorageReceiptAdmissionClass = "ordinary" | "delete-reserve";

export interface PreparedBoundedStorageTransaction {
  userId: string;
  clientId: string;
  command: Readonly<BoundedRecordTransactionCommand>;
  operationIdHash: string;
  requestHash: string;
  attemptHash: string;
  mutationsJson: string;
  maxResultBytes: number;
  receiptExpiresAt: number;
  receiptLimits: Readonly<BoundedStorageReceiptLimits>;
  deleteReceiptReserveLimits: Readonly<BoundedStorageReceiptLimits>;
  deleteOnly: boolean;
  now: number;
}

export interface BoundedStorageTransactionReceipt {
  userId: string;
  clientId: string;
  operationIdHash: string;
  requestHash: string;
  resultJson: string;
  resultBytes: number;
  createdAt: number;
  expiresAt: number;
  admissionClass: BoundedStorageReceiptAdmissionClass;
}

export async function prepareBoundedStorageTransaction(input: {
  userId: string;
  clientId: string;
  command: Readonly<BoundedRecordTransactionCommand>;
  limits: Readonly<StorageLimits>;
  receiptLimits: Readonly<BoundedStorageReceiptLimits>;
  receiptRetentionSeconds: number;
  now: number;
}): Promise<Readonly<PreparedBoundedStorageTransaction>> {
  assertNamespacePart(input.userId);
  assertNamespacePart(input.clientId);
  assertStorageLimits(input.limits);
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new RangeError("bounded_storage_transaction_now_invalid");
  }
  if (
    !Number.isSafeInteger(input.receiptRetentionSeconds) ||
    input.receiptRetentionSeconds <
      BOUNDED_RECORD_RECEIPT_MIN_RETENTION_SECONDS ||
    input.receiptRetentionSeconds >
      BOUNDED_RECORD_RECEIPT_MAX_RETENTION_SECONDS ||
    !Number.isSafeInteger(input.now + input.receiptRetentionSeconds)
  ) {
    throw new RangeError("bounded_storage_receipt_retention_invalid");
  }
  assertBoundedStorageReceiptLimits(input.receiptLimits);
  const command = decodeBoundedRecordTransaction(input.command);
  const deleteReceiptReserveLimits = boundedRecordDeleteReceiptReserveLimits(
    input.limits,
  );
  const canonicalRequest = canonicalBoundedRecordTransaction(command);
  const [operationIdHash, requestHash, attemptHash] = await Promise.all([
    sha256(command.transaction.operation_id),
    sha256(canonicalRequest),
    sha256(randomToken()),
  ]);
  const mutationsJson = JSON.stringify(command.transaction.mutations);
  return Object.freeze({
    userId: input.userId,
    clientId: input.clientId,
    command,
    operationIdHash,
    requestHash,
    attemptHash,
    mutationsJson,
    maxResultBytes: boundedRecordResultMaxBytes(
      command.transaction.mutations.length,
    ),
    receiptExpiresAt: input.now + input.receiptRetentionSeconds,
    receiptLimits: Object.freeze({ ...input.receiptLimits }),
    deleteReceiptReserveLimits,
    deleteOnly: command.transaction.mutations.every(
      (mutation) => mutation.type === "delete",
    ),
    now: input.now,
  });
}

export function boundedRecordDeleteReceiptReserveLimits(
  storageLimits: Readonly<StorageLimits>,
): Readonly<BoundedStorageReceiptLimits> {
  assertStorageLimits(storageLimits);
  return Object.freeze({
    globalMaxItems: storageLimits.globalMaxItems,
    globalMaxBytes: deleteReceiptReserveBytes(storageLimits.globalMaxItems),
    userMaxItems: storageLimits.userMaxItems,
    userMaxBytes: deleteReceiptReserveBytes(storageLimits.userMaxItems),
    namespaceMaxItems: storageLimits.namespaceMaxItems,
    namespaceMaxBytes: deleteReceiptReserveBytes(
      storageLimits.namespaceMaxItems,
    ),
  });
}

export function boundedRecordResultMaxBytes(mutationCount: number): number {
  if (
    !Number.isSafeInteger(mutationCount) ||
    mutationCount < 1 ||
    mutationCount > BOUNDED_RECORD_MAX_TRANSACTION_ENTRIES
  ) {
    throw new RangeError("bounded_storage_transaction_count_invalid");
  }
  return (
    mutationCount * BOUNDED_RECORD_MAX_RECORD_BYTES + RESULT_ENVELOPE_BYTES
  );
}

export function parseBoundedStorageTransactionResult(
  resultJson: string,
  command: Readonly<BoundedRecordTransactionCommand>,
): readonly (Readonly<BoundedRecord> | null)[] {
  const snapshot = decodeBoundedRecordTransaction(command);
  if (
    typeof resultJson !== "string" ||
    utf8Bytes(resultJson) >
      boundedRecordResultMaxBytes(snapshot.transaction.mutations.length)
  ) {
    throw new Error("bounded_storage_transaction_result_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson) as unknown;
  } catch {
    throw new Error("bounded_storage_transaction_result_invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== snapshot.transaction.mutations.length
  ) {
    throw new Error("bounded_storage_transaction_result_invalid");
  }

  const records: (Readonly<BoundedRecord> | null)[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const mutation = snapshot.transaction.mutations[index]!;
    const candidate = parsed[index];
    if (
      mutation.type === "delete" ||
      (mutation.type === "check" && mutation.expected_revision === null)
    ) {
      if (candidate !== null) resultInvalid();
      records.push(null);
      continue;
    }
    const record = parseResultRecord(candidate);
    if (
      record.key.collection !== mutation.key.collection ||
      record.key.id !== mutation.key.id
    ) {
      resultInvalid();
    }
    const expectedRevision =
      mutation.type === "put"
        ? (mutation.expected_revision ?? 0) + 1
        : mutation.expected_revision;
    if (record.revision !== expectedRevision) resultInvalid();
    if (
      mutation.type === "put" &&
      canonicalJson(record.value) !== canonicalJson(mutation.value)
    ) {
      resultInvalid();
    }
    records.push(record);
  }
  return boundedRecordTransactionDocument({
    operationId: snapshot.transaction.operation_id,
    replayed: false,
    records,
  }).data.records;
}

export function serializeBoundedStorageTransactionResult(
  records: readonly (Readonly<BoundedRecord> | null)[],
): Readonly<{ resultJson: string; resultBytes: number }> {
  const resultJson = JSON.stringify(records);
  return Object.freeze({ resultJson, resultBytes: utf8Bytes(resultJson) });
}

export function boundedStorageRecordResult(
  record: Readonly<BoundedStorageRecord>,
): Readonly<BoundedRecord> {
  let value: unknown;
  try {
    value = JSON.parse(record.valueJson) as unknown;
  } catch {
    throw new Error("bounded_storage_record_row_invalid");
  }
  return boundedRecordDocument({
    key: { collection: record.collection, id: record.id },
    revision: record.revision,
    value: value as BoundedRecordValue,
  }).data;
}

function parseResultRecord(value: unknown): Readonly<BoundedRecord> {
  const record = exactObject(value, ["key", "revision", "value"]);
  const key = decodeBoundedRecordKey(record.key);
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 1) {
    resultInvalid();
  }
  return boundedRecordDocument({
    key,
    revision: Number(record.revision),
    value: record.value as BoundedRecordValue,
  }).data;
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    resultInvalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) resultInvalid();
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    resultInvalid();
  }
  return value as Record<string, unknown>;
}

function canonicalJson(value: BoundedJsonValue | BoundedRecordValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          (value as Readonly<Record<string, BoundedJsonValue>>)[key]!,
        )}`,
    )
    .join(",")}}`;
}

function assertNamespacePart(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > NAMESPACE_PART_MAX_LENGTH
  ) {
    throw new RangeError("bounded_storage_transaction_namespace_invalid");
  }
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 0x1f || point === 0x7f) {
      throw new RangeError("bounded_storage_transaction_namespace_invalid");
    }
  }
}

function assertStorageLimits(limits: Readonly<StorageLimits>): void {
  if (
    typeof limits.writesEnabled !== "boolean" ||
    !positiveInteger(limits.globalMaxItems) ||
    !positiveInteger(limits.globalMaxBytes) ||
    !positiveInteger(limits.userMaxItems) ||
    !positiveInteger(limits.userMaxBytes) ||
    !positiveInteger(limits.namespaceMaxItems) ||
    !positiveInteger(limits.namespaceMaxBytes)
  ) {
    throw new RangeError("bounded_storage_transaction_limits_invalid");
  }
}

function assertBoundedStorageReceiptLimits(
  limits: Readonly<BoundedStorageReceiptLimits>,
): void {
  if (
    !positiveInteger(limits.globalMaxItems) ||
    !positiveInteger(limits.globalMaxBytes) ||
    !positiveInteger(limits.userMaxItems) ||
    !positiveInteger(limits.userMaxBytes) ||
    !positiveInteger(limits.namespaceMaxItems) ||
    !positiveInteger(limits.namespaceMaxBytes)
  ) {
    throw new RangeError("bounded_storage_receipt_limits_invalid");
  }
}

function deleteReceiptReserveBytes(itemLimit: number): number {
  const bytes = itemLimit * BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD;
  if (!Number.isSafeInteger(bytes)) {
    throw new RangeError("bounded_storage_transaction_limits_invalid");
  }
  return bytes;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function resultInvalid(): never {
  throw new Error("bounded_storage_transaction_result_invalid");
}
