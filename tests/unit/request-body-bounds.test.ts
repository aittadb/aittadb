import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_FORM_MAX_BYTES,
  readBoundedRequestBody,
  readForm,
} from "../../src/http";

test("bounded request reader accepts an exact declared limit", async () => {
  const bytes = new TextEncoder().encode("a".repeat(DEFAULT_FORM_MAX_BYTES));
  const request = new Request("https://aittadb.example.test/oauth/token", {
    method: "POST",
    headers: {
      "content-length": String(bytes.byteLength),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: bytes,
  });

  const result = await readBoundedRequestBody(request, bytes.byteLength);
  assert.equal(result.byteLength, bytes.byteLength);
});

test("bounded form reader parses only after the complete body fits", async () => {
  const request = new Request(
    "https://aittadb.example.test/oauth/device_authorization",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "client_id=public-client&scope=openid%20email",
    },
  );

  const form = await readForm(request);
  assert.equal(form.get("client_id"), "public-client");
  assert.equal(form.get("scope"), "openid email");
});

test("declared overflow cancels without pulling the request stream", async () => {
  const probe = streamProbe([new Uint8Array([1])]);
  const request = streamRequest(
    "https://aittadb.example.test/oauth/token",
    "application/x-www-form-urlencoded",
    probe.stream,
    String(DEFAULT_FORM_MAX_BYTES + 1),
  );

  await assert.rejects(
    readBoundedRequestBody(request, DEFAULT_FORM_MAX_BYTES),
    /request_too_large/,
  );
  assert.equal(probe.pulls, 0);
  assert.equal(probe.cancels, 1);
});

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
  url: string,
  contentType: string,
  body: ReadableStream<Uint8Array>,
  contentLength?: string,
): Request {
  const headers = new Headers({ "content-type": contentType });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return new Request(url, {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}
