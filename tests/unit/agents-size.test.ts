import assert from "node:assert/strict";
import test from "node:test";

import { assertAgentsSize, MAX_AGENTS_BYTES } from "../../scripts/agents-size";

test("AGENTS instruction budget rejects files at or above 32,000 bytes", () => {
  const encoder = new TextEncoder();
  assert.equal(
    assertAgentsSize(encoder.encode("x".repeat(MAX_AGENTS_BYTES - 1))),
    MAX_AGENTS_BYTES - 1,
  );
  assert.throws(
    () => assertAgentsSize(encoder.encode("x".repeat(MAX_AGENTS_BYTES))),
    /must remain below 32000 bytes/,
  );
});
