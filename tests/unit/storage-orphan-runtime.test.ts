import assert from "node:assert/strict";
import test from "node:test";

import { createAittaDBWithStore } from "../../src/handler";
import { MemoryAuthStore } from "../../src/store/memory";
import { MemoryR2Bucket, testEnv, testIdentityProvider } from "../helpers";

test("durable request schedules private orphan repair without disclosing its key", async () => {
  const store = new MemoryAuthStore();
  const bucket = new MemoryR2Bucket();
  const r2Key = "physical/private-repair-key";
  await store.recordStorageFileOrphanRepair({
    userId: "user-a",
    clientId: "client-a",
    r2Key,
    createdAt: 1,
    updatedAt: 1,
  });
  await bucket.put(r2Key, "orphan-body");
  const env = await testEnv({ BUCKET: bucket });
  const maintenance: Promise<unknown>[] = [];
  const app = createAittaDBWithStore(
    env,
    store,
    undefined,
    {
      waitUntil(promise) {
        maintenance.push(promise);
      },
    },
    testIdentityProvider(),
  );

  const response = await app.fetch(
    new Request("https://aittadb.example.test/session", {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(response?.status, 200);
  assert.equal((await response!.text()).includes(r2Key), false);
  assert.equal(maintenance.length, 2);
  await Promise.all(maintenance);
  assert.equal(bucket.objects.has(r2Key), false);
  assert.equal(store.storageFileOrphanRepairs.size, 0);
});
