/** Reading the body of a request whose route reads its own (`ownBody`), to a cap of the route's. */

/**
 * The body's bytes, or null once it is longer than `max`: said so by its `content-length`, before
 * a byte is read, or found so while reading, which then stops. What is left unread stays so. A
 * body of a stated length is read straight into one buffer of that length, so a large one is never
 * held twice.
 */
export async function readBodyUpTo(req: Request, max: number): Promise<Uint8Array | null> {
  const header = req.headers.get("content-length");
  const declared = header === null ? NaN : Number(header);
  if (Number.isSafeInteger(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array(0);
  const cap = Number.isSafeInteger(declared) && declared >= 0 ? declared : max;
  const reader = req.body.getReader();
  let out = new Uint8Array(Number.isSafeInteger(declared) ? declared : 0);
  let size = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    const chunk = next.value;
    if (size + chunk.byteLength > cap) {
      reader.releaseLock();
      return null;
    }
    // Without a stated length, the buffer doubles as it fills.
    if (size + chunk.byteLength > out.byteLength) {
      const grown = new Uint8Array(Math.min(max, Math.max(out.byteLength * 2, size + chunk.byteLength, 64 * 1024)));
      grown.set(out.subarray(0, size));
      out = grown;
    }
    out.set(chunk, size);
    size += chunk.byteLength;
  }
  return size === out.byteLength ? out : out.subarray(0, size);
}
