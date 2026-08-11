import assert from "node:assert/strict";
import test from "node:test";

import type { HypermediaDocument } from "../../src/hypermedia";
import { MemoryAuthStore } from "../../src/store/memory";
import { createTestAittaDB, testEnv } from "../helpers";

interface ServiceMetadata {
  features: {
    records: boolean;
    files: boolean;
    statistics: boolean;
    oauthApps: boolean;
    events: boolean;
  };
  capabilities: string[];
  plannedCapabilities: string[];
}

for (const [configured, expected] of [
  ["false", false],
  ["true", true],
] as const) {
  test(`Events ${configured} is visible as policy without advertising an unavailable operation`, async () => {
    const env = await testEnv({ FEATURE_EVENTS_ENABLED: configured });
    const app = createTestAittaDB(env, new MemoryAuthStore(), null);

    const jsonResponse = await app.fetch(
      new Request("https://aittadb.example.test/", {
        headers: {
          accept: "application/vnd.aittadb+json; version=0.1",
        },
      }),
    );
    assert.ok(jsonResponse);
    assert.equal(jsonResponse.status, 200);
    const document =
      (await jsonResponse.json()) as HypermediaDocument<ServiceMetadata>;
    assert.equal(document.data.features.events, expected);
    assert.deepEqual(document.data.plannedCapabilities, [
      "Persistent events and long-polling delivery",
    ]);
    assert.equal(
      document.data.capabilities.some((capability) =>
        /events/i.test(capability),
      ),
      false,
    );
    assert.equal(
      document.links.some(
        (item) =>
          item.rel.some((relation) => /events/i.test(relation)) ||
          new URL(item.href).pathname.startsWith("/events"),
      ),
      false,
    );
    assert.equal(
      document.actions.some(
        (item) =>
          /events/i.test(item.name) ||
          new URL(item.href).pathname.startsWith("/events"),
      ),
      false,
    );

    const htmlResponse = await app.fetch(
      new Request("https://aittadb.example.test/", {
        headers: { accept: "text/html" },
      }),
    );
    assert.ok(htmlResponse);
    assert.equal(htmlResponse.status, 200);
    const html = await htmlResponse.text();
    assert.match(html, new RegExp(`Events ${expected ? "on" : "off"}`));
    assert.doesNotMatch(html, /href="\/events(?:[/?#"])/);
  });
}
