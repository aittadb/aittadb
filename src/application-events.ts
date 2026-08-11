import type {
  ApplicationEvent,
  ApplicationEventInput,
  ApplicationEventLimits,
} from "./types";

export const APPLICATION_EVENT_MAX_DATA_BYTES = 64 * 1024;
export const APPLICATION_EVENT_MAX_TYPE_LENGTH = 128;
export const APPLICATION_EVENT_MAX_PAGE_SIZE = 100;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const EVENT_TYPE = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;

export function assertApplicationEventInput(
  input: ApplicationEventInput,
): void {
  if (!UUID_V4.test(input.id)) {
    throw new RangeError("application_event_id_invalid");
  }
  assertNamespacePart(input.userId, "principal");
  assertNamespacePart(input.clientId, "client");
  if (!EVENT_TYPE.test(input.type)) {
    throw new RangeError("application_event_type_invalid");
  }
  const dataBytes = new TextEncoder().encode(input.dataJson).byteLength;
  if (
    dataBytes !== input.dataBytes ||
    dataBytes < 2 ||
    dataBytes > APPLICATION_EVENT_MAX_DATA_BYTES
  ) {
    throw new RangeError("application_event_data_size_invalid");
  }
  if (!isJsonObject(input.dataJson)) {
    throw new RangeError("application_event_data_invalid");
  }
  if (
    input.idempotencyKeyHash !== null &&
    !SHA256_BASE64URL.test(input.idempotencyKeyHash)
  ) {
    throw new RangeError("application_event_idempotency_hash_invalid");
  }
  if (!SHA256_BASE64URL.test(input.requestHash)) {
    throw new RangeError("application_event_request_hash_invalid");
  }
  if (
    !Number.isSafeInteger(input.createdAt) ||
    input.createdAt < 0 ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= input.createdAt
  ) {
    throw new RangeError("application_event_time_invalid");
  }
}

export function assertApplicationEventLimits(
  limits: ApplicationEventLimits,
): void {
  for (const value of [
    limits.globalMaxItems,
    limits.globalMaxBytes,
    limits.userMaxItems,
    limits.userMaxBytes,
    limits.namespaceMaxItems,
    limits.namespaceMaxBytes,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError("application_event_limits_invalid");
    }
  }
}

export function assertApplicationEvent(event: ApplicationEvent): void {
  assertApplicationEventInput(event);
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new RangeError("application_event_sequence_invalid");
  }
}

export function assertApplicationEventNamespace(
  userId: string,
  clientId: string,
): void {
  assertNamespacePart(userId, "principal");
  assertNamespacePart(clientId, "client");
}

export function assertApplicationEventLookupInput(
  userId: string,
  clientId: string,
  id: string,
): void {
  assertApplicationEventNamespace(userId, clientId);
  if (!UUID_V4.test(id)) {
    throw new RangeError("application_event_id_invalid");
  }
}

export function assertApplicationEventPageInput(
  userId: string,
  clientId: string,
  afterSequence: number | null,
  limit: number,
): void {
  assertApplicationEventNamespace(userId, clientId);
  if (
    (afterSequence !== null &&
      (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > APPLICATION_EVENT_MAX_PAGE_SIZE
  ) {
    throw new RangeError("application_event_page_invalid");
  }
}

export function copyApplicationEvent(
  event: ApplicationEvent,
): ApplicationEvent {
  assertApplicationEvent(event);
  return { ...event };
}

function assertNamespacePart(value: string, name: string): void {
  if (value.length === 0 || value.length > 240) {
    throw new RangeError(`application_event_${name}_invalid`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      throw new RangeError(`application_event_${name}_invalid`);
    }
  }
}

function isJsonObject(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return (
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    );
  } catch {
    return false;
  }
}
