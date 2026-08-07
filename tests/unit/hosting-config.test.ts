import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSitesHostingConfig } from "../../build/hosting-config";

async function fixture(t: test.TestContext): Promise<{
  local: URL;
  template: URL;
}> {
  const directory = await mkdtemp(join(tmpdir(), "aittadb-hosting-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    local: pathToFileURL(join(directory, "hosting.json")),
    template: pathToFileURL(join(directory, "hosting.example.json")),
  };
}

test("uses the safe hosting template when local Sites metadata is absent", async (t) => {
  const paths = await fixture(t);
  await writeFile(
    paths.template,
    JSON.stringify({ project_id: "template", d1: "DB", r2: "BUCKET" }),
  );

  assert.deepEqual(loadSitesHostingConfig(paths.local, paths.template), {
    project_id: "template",
    d1: "DB",
    r2: "BUCKET",
  });
});

test("prefers checkout-local Sites metadata over the safe template", async (t) => {
  const paths = await fixture(t);
  await Promise.all([
    writeFile(
      paths.template,
      JSON.stringify({ project_id: "template", d1: "DB" }),
    ),
    writeFile(
      paths.local,
      JSON.stringify({ project_id: "local", d1: "LOCAL_DB", r2: "LOCAL_R2" }),
    ),
  ]);

  assert.deepEqual(loadSitesHostingConfig(paths.local, paths.template), {
    project_id: "local",
    d1: "LOCAL_DB",
    r2: "LOCAL_R2",
  });
});

test("rejects malformed hosting metadata instead of silently changing bindings", async (t) => {
  const paths = await fixture(t);
  await writeFile(paths.template, JSON.stringify({ d1: 42 }));

  assert.throws(
    () => loadSitesHostingConfig(paths.local, paths.template),
    /Invalid Sites hosting configuration field: d1/,
  );
});
