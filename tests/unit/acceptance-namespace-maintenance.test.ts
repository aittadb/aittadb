import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAcceptanceNamespaceMaintenanceInput,
  receiptIsBoundedToMaintenanceCollectionPrefix,
} from "../../src/acceptance-namespace-maintenance";
import type { BoundedStorageTransactionReceipt } from "../../src/bounded-record-transaction";

const PREFIX = "proof-0123456789abcdef01234567-";

test("acceptance maintenance receipts must be entirely within the requested collection prefix", () => {
  assert.equal(matches([`${PREFIX}records`]), true);
  assert.equal(matches([`${PREFIX}records`, "unrelated-records"]), false);
  assert.equal(matches([], [{ key: { collection: `${PREFIX}legacy` } }]), true);
  assert.equal(
    matches(
      [],
      [
        { key: { collection: `${PREFIX}legacy` } },
        { key: { collection: "unrelated-records" } },
      ],
    ),
    false,
  );
  assert.equal(matches([], [{ type: "delete", deleted: true }]), false);
  assert.equal(matches([42] as unknown as string[]), false);
  assert.equal(matches([`${PREFIX}records`, 42] as unknown as string[]), false);
  assert.equal(
    matches(
      [],
      [
        { key: { collection: `${PREFIX}legacy` } },
        { type: "delete", deleted: true },
      ],
    ),
    false,
  );
});

test("acceptance maintenance form decoding is exact and rejects ambiguous input", () => {
  const fields = new URLSearchParams({
    csrf_token: "csrf",
    submission_token: "submission",
    service_client_id: "11111111-1111-4111-8111-111111111111",
    collection_prefix: PREFIX,
  });
  assert.deepEqual(parseAcceptanceNamespaceMaintenanceInput(fields), {
    serviceClientId: "11111111-1111-4111-8111-111111111111",
    collectionPrefix: PREFIX,
  });

  const duplicate = new URLSearchParams(fields);
  duplicate.append("service_client_id", "22222222-2222-4222-8222-222222222222");
  assert.equal(parseAcceptanceNamespaceMaintenanceInput(duplicate), null);

  const unexpected = new URLSearchParams(fields);
  unexpected.set("extra", "value");
  assert.equal(parseAcceptanceNamespaceMaintenanceInput(unexpected), null);

  const nonUuid = new URLSearchParams(fields);
  nonUuid.set("service_client_id", "synthetic-service-client");
  assert.equal(parseAcceptanceNamespaceMaintenanceInput(nonUuid), null);

  const nonProofPrefix = new URLSearchParams(fields);
  nonProofPrefix.set("collection_prefix", "archive-0123456789abcdef01234567-");
  assert.equal(parseAcceptanceNamespaceMaintenanceInput(nonProofPrefix), null);
});

function matches(
  collectionNames: readonly string[],
  result: readonly unknown[] = [],
): boolean {
  const receipt: BoundedStorageTransactionReceipt = {
    userId: "user",
    clientId: "client",
    operationIdHash: "operation",
    requestHash: "request",
    resultJson: JSON.stringify(result),
    resultBytes: 2,
    collectionNamesJson: JSON.stringify(collectionNames),
    createdAt: 1,
    expiresAt: 2,
    admissionClass: "ordinary",
  };
  return receiptIsBoundedToMaintenanceCollectionPrefix(receipt, PREFIX);
}
