import { APPLICATION_EVENT_CLEANUP_BATCH_SIZE } from "../application-events";
import { STORAGE_FILE_WRITE_FENCE_CLEANUP_BATCH } from "../storage-file-write-fence";

export const CLEANUP_BATCH_SIZE = 500;
export const AUDIT_RETENTION_SECONDS = 90 * 24 * 60 * 60;
export const RATE_COUNTER_RETENTION_SECONDS = 5 * 60;
export const REFRESH_FAMILY_ORPHAN_GRACE_SECONDS = 60 * 60;

export const CLEANUP_CATEGORIES = [
  "file-write-fences",
  "application-events",
  "bounded-transaction-receipts",
  "authorization-codes",
  "authorization-requests",
  "device-grants",
  "refresh-tokens",
  "refresh-token-families",
  "revoked-access-tokens",
  "audit-events",
  "rate-limit-counters",
  "admin-submissions",
] as const;

export type CleanupCategory = (typeof CLEANUP_CATEGORIES)[number];

export const CLEANUP_CATEGORY_LIMITS: Readonly<
  Record<CleanupCategory, number>
> = {
  "file-write-fences": STORAGE_FILE_WRITE_FENCE_CLEANUP_BATCH,
  "application-events": APPLICATION_EVENT_CLEANUP_BATCH_SIZE,
  "bounded-transaction-receipts": CLEANUP_BATCH_SIZE,
  "authorization-codes": CLEANUP_BATCH_SIZE,
  "authorization-requests": CLEANUP_BATCH_SIZE,
  "device-grants": CLEANUP_BATCH_SIZE,
  "refresh-tokens": CLEANUP_BATCH_SIZE,
  "refresh-token-families": CLEANUP_BATCH_SIZE,
  "revoked-access-tokens": CLEANUP_BATCH_SIZE,
  "audit-events": CLEANUP_BATCH_SIZE,
  "rate-limit-counters": CLEANUP_BATCH_SIZE,
  "admin-submissions": CLEANUP_BATCH_SIZE,
};

export type CleanupCategoryReport =
  | {
      readonly status: "verified";
      readonly deletedCount: number;
      readonly limit: number;
    }
  | {
      readonly status: "unverifiable";
      readonly deletedCount: null;
      readonly limit: number;
    };

export type CleanupReport = Readonly<
  Record<CleanupCategory, CleanupCategoryReport>
>;

export const CLEANUP_FAILURE_EVENT = "maintenance.cleanup.failed";
export const CLEANUP_SUCCESS_EVENT = "maintenance.cleanup.completed";

export function createCleanupReport(
  counts: Readonly<Record<CleanupCategory, number | null>>,
): CleanupReport {
  const report = {} as Record<CleanupCategory, CleanupCategoryReport>;
  for (const category of CLEANUP_CATEGORIES) {
    const deletedCount = counts[category];
    const limit = CLEANUP_CATEGORY_LIMITS[category];
    report[category] =
      deletedCount !== null &&
      Number.isSafeInteger(deletedCount) &&
      deletedCount >= 0 &&
      deletedCount <= limit
        ? { status: "verified", deletedCount, limit }
        : { status: "unverifiable", deletedCount: null, limit };
  }
  return report;
}

export function cleanupTelemetryPayload(report: CleanupReport): string {
  return JSON.stringify({
    event: CLEANUP_SUCCESS_EVENT,
    categories: CLEANUP_CATEGORIES.map((category) => {
      const entry = report[category];
      const limit = CLEANUP_CATEGORY_LIMITS[category];
      const count =
        entry?.status === "verified" &&
        entry.limit === limit &&
        Number.isSafeInteger(entry.deletedCount) &&
        entry.deletedCount >= 0 &&
        entry.deletedCount <= limit
          ? entry.deletedCount
          : null;
      return { category, count, limit };
    }),
  });
}
