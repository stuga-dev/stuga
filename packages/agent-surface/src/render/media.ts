import type { StoredMedia } from "../backend.js";

/**
 * The Markdown that places a stored image. The title slot is the caption Stuga
 * renders; JSON.stringify matches how the document serializer writes it, and `]`
 * in alt is escaped because it would end the alt text early.
 */
export function imageMarkdown(path: string, alt: string | undefined, caption: string | undefined): string {
  const title = caption?.trim() ? ` ${JSON.stringify(caption.trim())}` : "";
  return `![${(alt ?? "").replace(/[[\]]/g, "\\$&")}](${path}${title})`;
}

/** The Markdown that links a stored file, by its name. */
export const fileMarkdown = (path: string, name: string): string => `[${name.replace(/[[\]\\*_`<]/g, "\\$&")}](${path})`;

/** Storing does not place anything; an agent that stops here leaves an upload nobody sees. */
export function renderUpload(stored: StoredMedia, alt: string | undefined, caption: string | undefined): string {
  const { url, hash, size, mime, name } = stored;
  if (stored.database) {
    return (
      JSON.stringify({ url, hash, size, mime, name }) +
      "\n[note] Stored with the database. Put `url` in a files column's cell with `databases_change` action:update_rows " +
      "or `databases_add` action:insert_rows — a cell holds one link per line, so keep the links already there."
    );
  }
  const markdown = name === undefined ? imageMarkdown(url, alt, caption) : fileMarkdown(url, name);
  return (
    JSON.stringify({ url, hash, size, mime, ...(name === undefined ? {} : { name }), markdown }) +
    "\n[note] Stored. Insert the `markdown` field above into the document with `markdown_edit` or " +
    `\`markdown_append\` — uploading does not place the ${name === undefined ? "image" : "file"} by itself.`
  );
}
