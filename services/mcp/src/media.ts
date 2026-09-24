/**
 * Base64 image decoding for the stdio server. The node's REST upload reads the
 * multipart part's declared type, so the type is sniffed here; the node still
 * checks the bytes against it.
 */
import { MAX_INLINE_IMAGE_BYTES } from "@stuga/agent-surface/catalog";
import type { SafeImageMime } from "@stuga/protocol/api/media";

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((value, index) => bytes[index] === value);

export function sniffImageMime(bytes: Uint8Array): SafeImageMime | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return "image/gif";
  }
  // RIFF alone is also WAV; the format tag eight bytes in decides.
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp";
  }
  return null;
}

/** Raw base64 or a whole data: URI, decoded and typed, or the refusal. */
export function decodeImage(data: string): { bytes: Uint8Array<ArrayBuffer>; mime: SafeImageMime } | { error: string } {
  const stripped = data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!stripped) return { error: "image data is empty" };
  // Buffer.from is lenient and would decode a truncated payload into garbage.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(stripped) || stripped.length % 4 !== 0) {
    return { error: "image data is not valid base64" };
  }
  // Copied out of Buffer's shared pool, so the Blob carries only these bytes.
  const bytes = new Uint8Array(Buffer.from(stripped, "base64"));
  if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
    return {
      error:
        `image too large (max ${Math.floor(MAX_INLINE_IMAGE_BYTES / (1024 * 1024))} MB inline) — ` +
        `write its URL into the document with \`markdown\` instead and the node will download and host it`,
    };
  }
  const mime = sniffImageMime(bytes);
  if (!mime) return { error: "unsupported image type — expected PNG, JPEG, GIF or WebP (SVG is not accepted)" };
  return { bytes, mime };
}
