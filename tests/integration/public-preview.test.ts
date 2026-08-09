import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { imageSize } from "image-size";

import { isAssetRoute } from "../../src/handler";
import { MemoryAuthStore } from "../../src/store/memory";
import { createTestAittaDB, testEnv } from "../helpers";

const SOCIAL_DESCRIPTION =
  "A hosted application backend with ChatGPT sign-in, AittaDB-issued sessions, isolated JSON records, and file storage.";

test("public root exposes social metadata to indifferent clients without User-Agent branching", async () => {
  const env = await testEnv();
  const app = createTestAittaDB(env, new MemoryAuthStore(), null);

  for (const headers of [
    new Headers({ accept: "*/*", "user-agent": "LinkedInBot/1.0" }),
    new Headers({ accept: "*/*", "user-agent": "command-line-client/1.0" }),
    new Headers({ "user-agent": "metadata-fetcher/1.0" }),
  ]) {
    const response = await app.fetch(
      new Request("https://aittadb.example.test/", { headers }),
    );
    assert.equal(response?.status, 200);
    assert.match(response?.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(response?.headers.get("vary"), "Accept");
    assert.match(
      response?.headers.get("content-security-policy") ?? "",
      /default-src 'self'/,
    );

    const body = await response!.text();
    assert.match(body, /<meta property="og:title" content="AittaDB">/);
    assert.match(body, /<meta property="og:site_name" content="AittaDB">/);
    assert.match(
      body,
      new RegExp(
        `<meta property="og:description" content="${SOCIAL_DESCRIPTION}">`,
      ),
    );
    assert.match(
      body,
      /<meta property="og:url" content="https:\/\/aittadb\.example\.test">/,
    );
    assert.match(
      body,
      /<meta property="og:image" content="https:\/\/aittadb\.example\.test\/og\.png">/,
    );
    assert.match(body, /<meta property="og:image:type" content="image\/png">/);
    assert.match(body, /<meta property="og:image:width" content="1200">/);
    assert.match(body, /<meta property="og:image:height" content="630">/);
    assert.ok(SOCIAL_DESCRIPTION.length <= 160);
    assert.match(body, />Sign in to AittaDB<\/a>/);
    assert.doesNotMatch(body, />Sign out<\/a>/);
  }

  const linkedInJson = await app.fetch(
    new Request("https://aittadb.example.test/", {
      headers: {
        accept: "application/json",
        "user-agent": "LinkedInBot/1.0",
      },
    }),
  );
  assert.equal(
    linkedInJson?.headers.get("content-type"),
    "application/json; charset=utf-8",
  );

  const vendorJson = await app.fetch(
    new Request("https://aittadb.example.test/", {
      headers: {
        accept: "application/vnd.aittadb+json; version=0.1",
        "user-agent": "LinkedInBot/1.0",
      },
    }),
  );
  assert.match(
    vendorJson?.headers.get("content-type") ?? "",
    /^application\/vnd\.aittadb\+json; version=0\.1/,
  );

  const explicitHtml = await app.fetch(
    new Request("https://aittadb.example.test/", {
      headers: { accept: "text/html", "user-agent": "api-client/1.0" },
    }),
  );
  assert.match(explicitHtml?.headers.get("content-type") ?? "", /^text\/html/);

  const indifferentHealth = await app.fetch(
    new Request("https://aittadb.example.test/health", {
      headers: { accept: "*/*" },
    }),
  );
  assert.equal(
    indifferentHealth?.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
});

test("public crawler assets are delegated with valid robots and social image files", async () => {
  const robots = await readFile(
    new URL("../../public/robots.txt", import.meta.url),
    "utf8",
  );
  assert.equal(robots, "User-agent: *\nAllow: /\n");
  assert.equal(isAssetRoute("/robots.txt"), true);

  const image = await readFile(new URL("../../public/og.png", import.meta.url));
  assert.deepEqual(imageSize(image), {
    width: 1200,
    height: 630,
    type: "png",
  });
  assert.equal(isAssetRoute("/og.png"), true);

  const app = createTestAittaDB(await testEnv(), new MemoryAuthStore(), null);
  assert.equal(
    await app.fetch(new Request("https://aittadb.example.test/robots.txt")),
    null,
  );
  assert.equal(
    await app.fetch(new Request("https://aittadb.example.test/og.png")),
    null,
  );
});
