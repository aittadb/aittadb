import type { AuditEventAttribution } from "./types";

const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/;

export function assertAuditEventAttribution(
  attribution: AuditEventAttribution | undefined,
): void {
  if (
    attribution !== undefined &&
    !SHA256_BASE64URL.test(attribution.actorSubjectHash)
  ) {
    throw new RangeError("audit_actor_subject_hash_invalid");
  }
}
