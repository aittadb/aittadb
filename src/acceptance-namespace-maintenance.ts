import type { AcceptanceNamespaceMaintenanceInput, ClientView } from "./types";
import type { BoundedStorageTransactionReceipt } from "./bounded-record-transaction";

/** Acceptance-only operator resource; unavailable unless its explicit flag is enabled. */
export const ACCEPTANCE_NAMESPACE_MAINTENANCE_PATH =
  "/admin/maintenance/bounded-service-namespaces";

/** A deliberately small bound keeps one maintenance request reversible and inspectable. */
export const ACCEPTANCE_NAMESPACE_MAINTENANCE_MAX_ROWS = 100;

/** A transaction has at most 25 unique collection entries, plus one overflow sentinel. */
export const ACCEPTANCE_NAMESPACE_MAINTENANCE_MAX_RECEIPT_COLLECTION_ROWS =
  ACCEPTANCE_NAMESPACE_MAINTENANCE_MAX_ROWS * 25 + 1;

/** The maintenance primitive is only for a disposable acceptance proof run. */
const SAFE_COLLECTION_PREFIX = /^proof-[a-f0-9]{24}-$/;
const CANONICAL_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAINTENANCE_FORM_FIELDS = new Set([
  "csrf_token",
  "submission_token",
  "service_client_id",
  "collection_prefix",
]);

export function isSafeMaintenanceCollectionPrefix(value: string): boolean {
  return SAFE_COLLECTION_PREFIX.test(value);
}

export function parseAcceptanceNamespaceMaintenanceInput(
  form: URLSearchParams,
): AcceptanceNamespaceMaintenanceInput | null {
  const names = [...form.keys()];
  if (names.some((name) => !MAINTENANCE_FORM_FIELDS.has(name))) return null;
  if (
    [...MAINTENANCE_FORM_FIELDS].some((name) => form.getAll(name).length !== 1)
  ) {
    return null;
  }
  const serviceClientIds = form.getAll("service_client_id");
  const prefixes = form.getAll("collection_prefix");
  const serviceClientId = serviceClientIds[0] ?? "";
  const collectionPrefix = prefixes[0] ?? "";
  if (
    !CANONICAL_UUID_V4.test(serviceClientId) ||
    !isSafeMaintenanceCollectionPrefix(collectionPrefix)
  ) {
    return null;
  }
  return { serviceClientId, collectionPrefix };
}

export function isEligibleMaintenanceServiceClient(
  client: Readonly<ClientView>,
): boolean {
  return (
    client.type === "service" &&
    client.disabledAt === null &&
    client.redirectUris.length === 0 &&
    client.origins.length === 0
  );
}

/**
 * New receipts retain only their transaction collection names, never record keys,
 * values, operation IDs, or credentials. Legacy receipts can be recognized
 * only when their bounded result includes a record key.
 */
export function receiptIsBoundedToMaintenanceCollectionPrefix(
  receipt: Readonly<BoundedStorageTransactionReceipt>,
  collectionPrefix: string,
): boolean {
  const collectionNames = parseCollectionNames(receipt.collectionNamesJson);
  if (collectionNames === null) return false;
  const candidates =
    collectionNames.length > 0
      ? collectionNames
      : legacyReceiptCollections(receipt.resultJson);
  return (
    candidates !== null &&
    candidates.length > 0 &&
    candidates.every((collection) => collection.startsWith(collectionPrefix))
  );
}

function parseCollectionNames(value: string): readonly string[] | null {
  try {
    const decoded: unknown = JSON.parse(value);
    if (!Array.isArray(decoded)) return null;
    if (!decoded.every((entry) => typeof entry === "string")) return null;
    return decoded;
  } catch {
    return null;
  }
}

function legacyReceiptCollections(value: string): readonly string[] | null {
  try {
    const decoded: unknown = JSON.parse(value);
    if (!Array.isArray(decoded)) return [];
    const collections: string[] = [];
    for (const entry of decoded) {
      if (!isRecordWithKey(entry)) return null;
      collections.push(entry.key.collection);
    }
    return collections.length > 0 ? collections : null;
  } catch {
    return null;
  }
}

function isRecordWithKey(
  value: unknown,
): value is { key: { collection: string } } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const key = (value as { key?: unknown }).key;
  if (typeof key !== "object" || key === null || Array.isArray(key)) {
    return false;
  }
  return typeof (key as { collection?: unknown }).collection === "string";
}
