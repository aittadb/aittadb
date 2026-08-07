import { imageDimensionsFromData } from "image-dimensions";

export function imageSize(input) {
  const bytes = toBytes(input);
  const dimensions = imageDimensionsFromData(bytes);
  if (!dimensions) throw new TypeError("Unsupported or invalid image data");
  return dimensions;
}

export default imageSize;

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError("Expected image data as an ArrayBuffer or typed array");
}
