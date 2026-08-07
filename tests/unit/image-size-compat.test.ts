import assert from "node:assert/strict";
import test from "node:test";

import { imageSize } from "image-size";

const ONE_PIXEL_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

test("Vinext image-size compatibility adapter reads supported metadata", () => {
  assert.deepEqual(imageSize(ONE_PIXEL_PNG), {
    width: 1,
    height: 1,
    type: "png",
  });
});

test("Vinext image-size compatibility adapter rejects zero-sized container boxes", () => {
  const malformedIcns = Uint8Array.from([
    0x69, 0x63, 0x6e, 0x73, 0, 0, 0, 16, 0x69, 0x63, 0x30, 0x7a, 0, 0, 0, 0,
  ]);
  const malformedHeif = Uint8Array.from([
    0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0,
  ]);

  assert.throws(() => imageSize(malformedIcns), /invalid image data/i);
  assert.throws(() => imageSize(malformedHeif), /invalid image data/i);
});
