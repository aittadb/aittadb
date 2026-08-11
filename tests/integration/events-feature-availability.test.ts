import assert from "node:assert/strict";
import test from "node:test";

import { createAittaDBWithStore } from "../../src/handler";
import type { HypermediaDocument } from "../../src/hypermedia";
import { MemoryAuthStore } from "../../src/store/memory";
import type { AuthStore } from "../../src/types";
import { createTestAittaDB, testEnv, testIdentityProvider } from "../helpers";

const ISSUER = "https://aittadb.example.test";
const HYPERMEDIA = "application/vnd.aittadb+json; version=0.1";

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
  test(`Events ${configured} controls publication and read discovery consistently`, async () => {
    const env = await testEnv({ FEATURE_EVENTS_ENABLED: configured });
    const app = createTestAittaDB(env, new MemoryAuthStore());

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
    assert.deepEqual(document.data.plannedCapabilities, []);
    assert.equal(
      document.data.capabilities.some((capability) =>
        /event/i.test(capability),
      ),
      expected,
    );
    assert.equal(
      document.links.some(
        (item) =>
          item.rel.some((relation) => /events/i.test(relation)) ||
          new URL(item.href).pathname.startsWith("/events"),
      ),
      expected,
    );
    assert.equal(
      document.actions.some(
        (item) =>
          /events/i.test(item.name) ||
          new URL(item.href).pathname.startsWith("/events"),
      ),
      expected,
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
    assert.equal(/href="\/events(?:[/?#"])/.test(html), expected);

    const sessionResponse = await app.fetch(
      new Request(`${ISSUER}/session`, {
        headers: { accept: HYPERMEDIA },
      }),
    );
    assert.equal(sessionResponse?.status, 200);
    const session = (await sessionResponse!.json()) as HypermediaDocument<
      Record<string, unknown>
    >;
    assert.equal(
      session.links.some((item) => new URL(item.href).pathname === "/events"),
      expected,
    );
    assert.equal(
      session.actions.some(
        (item) =>
          item.name === "manage-session-events" &&
          new URL(item.href).pathname === "/events",
      ),
      expected,
    );
  });
}

test("disabled Events rejects publication before body, identity, repository, or maintenance work", async () => {
  const env = await testEnv({ FEATURE_EVENTS_ENABLED: "false" });
  const observed = observeRepositoryCalls(new MemoryAuthStore());
  const scheduled: Promise<unknown>[] = [];
  let identityReads = 0;
  const identityProvider = testIdentityProvider();
  const app = createAittaDBWithStore(
    env,
    observed.store,
    undefined,
    { waitUntil: (promise) => scheduled.push(promise) },
    {
      read(request) {
        identityReads += 1;
        return identityProvider.read(request);
      },
    },
  );

  const readResponse = await app.fetch(
    new Request(`${ISSUER}/events`, { headers: { accept: HYPERMEDIA } }),
  );
  await assertUnavailable(readResponse);

  const tracked = streamedJsonRequest();
  const writeResponse = await app.fetch(tracked.request);
  await assertUnavailable(writeResponse);

  assert.equal(tracked.pulls(), 0);
  assert.equal(identityReads, 0);
  assert.deepEqual(observed.calls, []);
  assert.deepEqual(scheduled, []);
});

async function assertUnavailable(response: Response | null): Promise<void> {
  assert.equal(response?.status, 503);
  assert.equal(response?.headers.get("cache-control"), "no-store");
  const document = (await response!.json()) as {
    error: string;
    data: { error_description: string };
  };
  assert.equal(document.error, "feature_unavailable");
  assert.match(document.data.error_description, /Events is disabled/);
}

function streamedJsonRequest(): { request: Request; pulls(): number } {
  let pullCount = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pullCount += 1;
        controller.enqueue(
          new TextEncoder().encode('{"type":"must.not.be.read","data":{}}'),
        );
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      accept: HYPERMEDIA,
      "content-type": "application/json",
      origin: "https://untrusted.example.test",
    },
    body,
    duplex: "half",
  };
  return {
    request: new Request(`${ISSUER}/events`, init),
    pulls: () => pullCount,
  };
}

function observeRepositoryCalls(target: MemoryAuthStore): {
  store: AuthStore;
  calls: string[];
} {
  const calls: string[] = [];
  const store = new Proxy(target, {
    get(current, property) {
      const value = Reflect.get(current, property, current) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return Reflect.apply(value, current, args) as unknown;
      };
    },
  }) as AuthStore;
  return { store, calls };
}
