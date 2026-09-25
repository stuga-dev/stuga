import type { StoredImage } from "../backend.js";

/**
 * The Markdown that places a stored image. The title slot is the caption Stuga
 * renders; JSON.stringify matches how the document serializer writes it, and `]`
 * in alt is escaped because it would end the alt text early.
 */
export function imageMarkdown(path: string, alt: string | undefined, caption: string | undefined): string {
  const title = caption?.trim() ? ` ${JSON.stringify(caption.trim())}` : "";
  return `![${(alt ?? "").replace(/[[\]]/g, "\\$&")}](${path}${title})`;
}

/** Storing an image does not place it; an agent that stops here leaves an upload nobody sees. */
export function renderUpload(stored: StoredImage, alt: string | undefined, caption: string | undefined): string {
  return (
    JSON.stringify({ url: stored.url, hash: stored.hash, size: stored.size, mime: stored.mime, markdown: imageMarkdown(stored.url, alt, caption) }) +
    "\n[note] Stored. Insert the `markdown` field above into the document with `markdown_edit` or " +
    "`markdown_append` — uploading does not place the image by itself."
  );
}
