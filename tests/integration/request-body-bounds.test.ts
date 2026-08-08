import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_FORM_MAX_BYTES } from "../../src/http";
import { openApiSpec } from "../../src/openapi";
import { MAX_RECORD_BYTES } from "../../src/storage";
import { MemoryAuthStore } from "../../src/store/memory";
import type { AuthStore } from "../../src/types";
import { createTestAittaDB, testEnv } from "../helpers";

interface BodyTarget {
  name: string;
  url: string;
  method: "POST" | "PUT";
  contentType: string;
  maxBytes: number;
  description: string;
}

interface OversizedBodyCase {
  name: string;
  chunks: readonly Uint8Array[];
  contentLength?: string;
  expectedPulls?: number;
}

const TARGETS: readonly BodyTarget[] = [
  {
    name: "URL-encoded form",
    url: "https://aittadb.example.test/oauth/device_authorization",
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    maxBytes: DEFAULT_FORM_MAX_BYTES,
    description: "Request is too large",
  },
  {
    name: "JSON record",
    url: "https://aittadb.example.test/storage/records/body-bound",
    method: "PUT",
    contentType: "application/json",
    maxBytes: MAX_RECORD_BYTES,
    description: "Storage record is too large",
  },
];

test("accepted URL-encoded and JSON bodies reject every oversized length variant before repository access", async () => {
  const env = await testEnv();
  const observed = observedStore();
  const app = createTestAittaDB(env, observed.store, null);

  for (const target of TARGETS) {
    const cases: readonly OversizedBodyCase[] = [
      {
        name: "declared overflow",
        chunks: [new Uint8Array([1])],
        contentLength: String(target.maxBytes + 1),
        expectedPulls: 0,
      },
      {
        name: "undeclared overflow",
        chunks: [invalidPrefix(target), new Uint8Array(target.maxBytes + 1)],
      },
      {
        name: "undersized Content-Length",
        chunks: [invalidPrefix(target), new Uint8Array(target.maxBytes + 1)],
        contentLength: "1",
      },
      {
        name: "malformed Content-Length",
        chunks: [invalidPrefix(target), new Uint8Array(target.maxBytes + 1)],
        contentLength: "not-a-length",
      },
      {
        name: "chunked streamed overflow",
        chunks: [
          invalidPrefix(target),
          new Uint8Array(target.maxBytes - invalidPrefix(target).byteLength),
          new Uint8Array([1]),
        ],
      },
    ];

    for (const testCase of cases) {
      observed.calls.length = 0;
      const probe = streamProbe(testCase.chunks);
      const response = await app.fetch(
        streamRequest(target, probe.stream, testCase.contentLength),
      );
      assert.equal(response?.status, 413, `${target.name}: ${testCase.name}`);
      const payload = (await response!.json()) as {
        error: string;
        error_description: string;
      };
      assert.equal(payload.error, "invalid_request");
      assert.equal(payload.error_description, target.description);
      assert.deepEqual(
        observed.calls,
        [],
        `${target.name}: ${testCase.name} reached repository`,
      );
      if (testCase.expectedPulls !== undefined) {
        assert.equal(probe.pulls, testCase.expectedPulls);
      } else {
        assert.ok(probe.pulls > 0);
      }
      assert.equal(probe.cancels, 1);
    }
  }
});

test("malformed accepted request streams fail before parsing or repository access", async () => {
  const env = await testEnv();
  const observed = observedStore();
  const app = createTestAittaDB(env, observed.store, null);

  for (const target of TARGETS) {
    observed.calls.length = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.error(new Error("synthetic stream failure"));
        },
      },
      { highWaterMark: 0 },
    );
    const response = await app.fetch(streamRequest(target, body));
    assert.equal(response?.status, 400, target.name);
    const payload = (await response!.json()) as {
      error: string;
      error_description: string;
    };
    assert.equal(payload.error, "invalid_request");
    assert.equal(payload.error_description, "Malformed request body");
    assert.deepEqual(observed.calls, [], target.name);
  }
});

test("OpenAPI documents bounded-body rejection on every accepted URL-encoded and JSON operation", () => {
  const operations = [
    ["/oauth/device_authorization", "post"],
    ["/oauth/token", "post"],
    ["/oauth/revoke", "post"],
    ["/oauth/introspect", "post"],
    ["/userinfo", "post"],
    ["/storage/records", "post"],
    ["/storage/records/{key}", "post"],
    ["/storage/records/{key}", "put"],
    ["/storage/files", "post"],
    ["/storage/files/{key}", "post"],
    ["/device", "post"],
    ["/device/decision", "post"],
    ["/consent", "post"],
    ["/admin/clients", "post"],
  ] as const;
  const paths = openApiSpec.paths as Record<
    string,
    Record<string, { responses?: Record<string, { description?: string }> }>
  >;

  for (const [path, method] of operations) {
    const response = paths[path]?.[method]?.responses?.["413"];
    assert.ok(response, `${method.toUpperCase()} ${path}`);
    assert.match(response.description ?? "", /bound|limit|exceed/i);
  }
});

function invalidPrefix(target: BodyTarget): Uint8Array {
  return new TextEncoder().encode(
    target.contentType === "application/json" ? "{" : "invalid=%",
  );
}

function observedStore(): { store: AuthStore; calls: string[] } {
  const target = new MemoryAuthStore();
  const calls: string[] = [];
  const store = new Proxy(target, {
    get(instance, property) {
      const value = Reflect.get(instance, property, instance) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return Reflect.apply(value, instance, args) as unknown;
      };
    },
  }) as AuthStore;
  return { store, calls };
}

interface StreamProbe {
  stream: ReadableStream<Uint8Array>;
  readonly pulls: number;
  readonly cancels: number;
}

function streamProbe(chunks: readonly Uint8Array[]): StreamProbe {
  let pulls = 0;
  let cancels = 0;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        const chunk = chunks[index];
        index += 1;
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancels += 1;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    stream,
    get pulls() {
      return pulls;
    },
    get cancels() {
      return cancels;
    },
  };
}

function streamRequest(
  target: BodyTarget,
  body: ReadableStream<Uint8Array>,
  contentLength?: string,
): Request {
  const headers = new Headers({
    accept: "application/json",
    "content-type": target.contentType,
  });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return new Request(target.url, {
    method: target.method,
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}
