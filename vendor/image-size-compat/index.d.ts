export interface ImageDimensions {
  width: number;
  height: number;
  type: string;
}

export declare function imageSize(
  input: Uint8Array | ArrayBuffer | ArrayBufferView,
): ImageDimensions;

export default imageSize;
