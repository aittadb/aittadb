export const MAX_AGENTS_BYTES = 32_000;

export function assertAgentsSize(
  contents: Uint8Array,
  label = "AGENTS.md",
): number {
  const bytes = contents.byteLength;
  if (bytes >= MAX_AGENTS_BYTES) {
    throw new Error(
      `${label} is ${bytes} bytes; it must remain below ${MAX_AGENTS_BYTES} bytes`,
    );
  }
  return bytes;
}
