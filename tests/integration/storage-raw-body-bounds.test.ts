import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { nowSeconds, sha256 } from "../../src/crypto";
import { createClientRegistration, issueTokens } from "../../src/oauth";
import { openApiSpec } from "../../src/openapi";
import { MAX_FILE_BYTES } from "../../src/storage";
import { MemoryAuthStore } from "../../src/store/memory";
import type {
  ClientView,
  LocalUser,
  StorageFileMetadata,
  StorageLimits,
} from "../../src/types";
import { createTestAittaDB, MemoryR2Bucket, testEnv } from "../helpers";

const EXISTING_KEY = "raw-bounds/existing.bin";

interface RawUploadFixture {
  app: ReturnType<typeof createTestAittaDB>;
  bucket: MutationTrackingBucket;
  store: MutationTrackingStore;
  accessToken: string;
  user: LocalUser;
  client: ClientView;
  existing: StorageFileMetadata;
}

interface RawUploadTarget {
  name: string;
  method: "POST" | "PUT";
  path: string;
}

interface OversizedRawUploadCase {
  name: string;
  probe: () => StreamProbe;
  contentLength?: string;
  expectedPulls: number;
}

const TARGETS: readonly RawUploadTarget[] = [
  { name: "collection create", method: "POST", path: "/storage/files" },
  {
    name: "item replace",
    method: "PUT",
    path: `/storage/files/${EXISTING_KEY}`,
  },
];

test("canonical raw uploads enforce the shared stream bound before R2 or file-metadata mutation", async () => {
  const fixture = await rawUploadFixture();

  for (const target of TARGETS) {
    const cases: readonly OversizedRawUploadCase[] = [
      {
        name: "declared overflow",
        probe: () => streamProbe([1]),
        contentLength: String(MAX_FILE_BYTES + 1),
        expectedPulls: 0,
      },
      {
        name: "absent Content-Length",
        probe: () => streamProbe([MAX_FILE_BYTES + 1, 1]),
        expectedPulls: 1,
      },
      {
        name: "malformed Content-Length",
        probe: () => streamProbe([MAX_FILE_BYTES + 1, 1]),
        contentLength: "not-a-length",
        expectedPulls: 1,
      },
      {
        name: "deliberately undersized Content-Length",
        probe: () => streamProbe([MAX_FILE_BYTES + 1, 1]),
        contentLength: "1",
        expectedPulls: 1,
      },
      {
        name: "chunked streamed overflow",
        probe: () =>
          streamProbe([
            Math.floor(MAX_FILE_BYTES / 2),
            MAX_FILE_BYTES - Math.floor(MAX_FILE_BYTES / 2),
            1,
            1,
          ]),
        expectedPulls: 3,
      },
    ];

    for (const testCase of cases) {
      fixture.bucket.resetMutationCounts();
      fixture.store.resetMutationCounts();
      const probe = testCase.probe();
      const response = await requiredResponse(
        fixture.app.fetch(
          rawUploadRequest(
            fixture,
            target,
            probe.stream,
            testCase.contentLength,
          ),
        ),
      );

      assert.equal(response.status, 413, `${target.name}: ${testCase.name}`);
      const payload = (await response.json()) as {
        error: string;
        error_description: string;
      };
      assert.equal(payload.error, "invalid_request");
      assert.equal(payload.error_description, "Storage file is too large");
      assert.equal(
        probe.pulls,
        testCase.expectedPulls,
        `${target.name}: ${testCase.name} pulled beyond its boundary`,
      );
      assert.equal(probe.cancels, 1, `${target.name}: ${testCase.name}`);
      await assertNoResourceMutation(fixture, target, testCase.name);
    }
  }
});

test("failed canonical raw upload streams return the documented 400 without resource mutation", async () => {
  const fixture = await rawUploadFixture();

  for (const target of TARGETS) {
    fixture.bucket.resetMutationCounts();
    fixture.store.resetMutationCounts();
    const probe = failedStreamProbe();
    const response = await requiredResponse(
      fixture.app.fetch(rawUploadRequest(fixture, target, probe.stream)),
    );

    assert.equal(response.status, 400, target.name);
    const payload = (await response.json()) as {
      error: string;
      error_description: string;
    };
    assert.equal(payload.error, "invalid_request");
    assert.equal(payload.error_description, "Malformed request body");
    assert.equal(probe.pulls, 1, target.name);
    assert.equal(probe.cancels, 0, target.name);
    await assertNoResourceMutation(fixture, target, "failed stream");
  }
});

test("bounded canonical raw uploads still create and replace files", async () => {
  const fixture = await rawUploadFixture();
  const createBody = new TextEncoder().encode("bounded create");
  fixture.bucket.resetMutationCounts();
  fixture.store.resetMutationCounts();

  const created = await requiredResponse(
    fixture.app.fetch(
      rawUploadRequest(
        fixture,
        TARGETS[0]!,
        streamProbe([createBody.byteLength], createBody).stream,
        String(createBody.byteLength),
      ),
    ),
  );
  assert.equal(created.status, 201);
  assert.equal(fixture.bucket.putCalls, 1);
  assert.equal(fixture.store.fileMetadataWrites, 1);

  const replaceBody = new TextEncoder().encode("bounded replacement");
  fixture.bucket.resetMutationCounts();
  fixture.store.resetMutationCounts();
  const replaced = await requiredResponse(
    fixture.app.fetch(
      rawUploadRequest(
        fixture,
        TARGETS[1]!,
        streamProbe([replaceBody.byteLength], replaceBody).stream,
      ),
    ),
  );
  assert.equal(replaced.status, 200);
  assert.equal(fixture.bucket.putCalls, 1);
  assert.equal(fixture.store.fileMetadataWrites, 1);
  const metadata = await fixture.store.getStorageFileMetadata(
    fixture.user.id,
    fixture.client.id,
    EXISTING_KEY,
  );
  assert.ok(metadata);
  assert.equal(metadata.size, replaceBody.byteLength);
  assert.equal(metadata.sha256, await sha256(replaceBody));
});

test("OpenAPI documents raw-file overflow and failed-stream errors", () => {
  const paths = openApiSpec.paths as Record<
    string,
    Record<string, { responses?: Record<string, { description?: string }> }>
  >;
  const operations = [
    ["/storage/files", "post"],
    ["/storage/files/{key}", "put"],
  ] as const;

  for (const [path, method] of operations) {
    const responses = paths[path]?.[method]?.responses;
    assert.match(responses?.["400"]?.description ?? "", /malformed|stream/i);
    assert.match(responses?.["413"]?.description ?? "", /raw|file bytes/i);
    assert.match(responses?.["413"]?.description ?? "", /R2.*D1|D1.*R2/i);
  }
});

async function rawUploadFixture(): Promise<RawUploadFixture> {
  const bucket = new MutationTrackingBucket();
  const env = await testEnv({
    BUCKET: bucket,
    STORAGE_WRITE_RATE_LIMIT: "1000",
  });
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new MutationTrackingStore();
  const user = await store.findOrCreateUser(
    {
      email: "raw-bounds@example.test",
      fullName: "Raw Bounds User",
      displayName: "Raw Bounds User",
    },
    nowSeconds(),
  );
  const client = (
    await createClientRegistration(
      {
        type: "public",
        name: "Raw Bounds Client",
        redirectUris: ["https://raw-bounds.example.test/callback"],
        scopes: ["storage.write"],
        origins: [],
      },
      store,
      nowSeconds(),
    )
  ).client;
  const tokenSet = await issueTokens({
    config,
    store,
    user,
    client,
    scope: "storage.write",
    includeRefresh: false,
    now: nowSeconds(),
  });
  const seedBody = new Uint8Array([1, 2, 3, 4]);
  const existing: StorageFileMetadata = {
    userId: user.id,
    clientId: client.id,
    key: EXISTING_KEY,
    r2Key: "private/raw-bounds-existing",
    contentType: "application/octet-stream",
    size: seedBody.byteLength,
    sha256: await sha256(seedBody),
    createdAt: nowSeconds(),
    updatedAt: nowSeconds(),
  };
  await bucket.put(existing.r2Key, seedBody);
  assert.equal(
    await store.upsertStorageFileMetadata(existing, null, config.storageLimits),
    true,
  );
  bucket.resetMutationCounts();
  store.resetMutationCounts();

  return {
    app: createTestAittaDB(env, store),
    bucket,
    store,
    accessToken: String(tokenSet.access_token),
    user,
    client,
    existing,
  };
}

function rawUploadRequest(
  fixture: RawUploadFixture,
  target: RawUploadTarget,
  body: ReadableStream<Uint8Array>,
  contentLength?: string,
): Request {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${fixture.accessToken}`,
    "content-type": "application/octet-stream",
  });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return new Request(`https://aittadb.example.test${target.path}`, {
    method: target.method,
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

async function assertNoResourceMutation(
  fixture: RawUploadFixture,
  target: RawUploadTarget,
  caseName: string,
): Promise<void> {
  assert.equal(fixture.bucket.putCalls, 0, `${target.name}: ${caseName}`);
  assert.equal(
    fixture.store.fileMetadataWrites,
    0,
    `${target.name}: ${caseName}`,
  );
  const metadata = await fixture.store.getStorageFileMetadata(
    fixture.user.id,
    fixture.client.id,
    EXISTING_KEY,
  );
  assert.deepEqual(metadata, fixture.existing, `${target.name}: ${caseName}`);
  assert.equal(fixture.bucket.objects.size, 1, `${target.name}: ${caseName}`);
  const bytes = await fixture.bucket.get(fixture.existing.r2Key);
  assert.ok(bytes, `${target.name}: ${caseName}`);
  assert.deepEqual(
    new Uint8Array(await bytes.arrayBuffer()),
    new Uint8Array([1, 2, 3, 4]),
  );
}

interface StreamProbe {
  stream: ReadableStream<Uint8Array>;
  readonly pulls: number;
  readonly cancels: number;
}

function streamProbe(
  chunkSizes: readonly number[],
  fixedChunk?: Uint8Array,
): StreamProbe {
  let pulls = 0;
  let cancels = 0;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        const size = chunkSizes[index];
        index += 1;
        if (size === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(
          fixedChunk && fixedChunk.byteLength === size
            ? fixedChunk
            : new Uint8Array(size),
        );
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

function failedStreamProbe(): StreamProbe {
  let pulls = 0;
  let cancels = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        controller.error(new Error("synthetic raw stream failure"));
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

class MutationTrackingBucket extends MemoryR2Bucket {
  putCalls = 0;

  override async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown> {
    this.putCalls += 1;
    return super.put(key, value, options);
  }

  resetMutationCounts(): void {
    this.putCalls = 0;
  }
}

class MutationTrackingStore extends MemoryAuthStore {
  fileMetadataWrites = 0;

  override async upsertStorageFileMetadata(
    file: StorageFileMetadata,
    expectedR2Key: string | null,
    limits?: StorageLimits,
  ): Promise<boolean> {
    this.fileMetadataWrites += 1;
    return super.upsertStorageFileMetadata(file, expectedR2Key, limits);
  }

  resetMutationCounts(): void {
    this.fileMetadataWrites = 0;
  }
}

async function requiredResponse(
  response: Promise<Response | null | undefined>,
): Promise<Response> {
  const value = await response;
  assert.ok(value);
  return value;
}
