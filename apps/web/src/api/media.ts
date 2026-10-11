import { t } from "../i18n/i18n";
import { authHeaders, failureFrom, observeResponse } from "../lib/http/client";
import { byteSize } from "../lib/format";

/**
 * A file refused for its size, named with its size and the limit, or null when the node's own
 * sentence (which names the limit) says it better. The node's listener names the ceiling of the
 * whole request, a little over the file limit for the form around it, which rounds the same.
 */
function tooLarge(file: File, body: unknown): Error | null {
  const { max_bytes: max, error } = body && typeof body === "object" ? (body as { max_bytes?: unknown; error?: unknown }) : {};
  const name = file.name || t("editor.upload.defaultFileName");
  const size = byteSize(file.size);
  if (typeof max === "number" && max > 0) return new Error(t("errors.client.fileTooLarge", { name, size, limit: byteSize(max) }));
  return typeof error === "string" ? null : new Error(t("errors.client.fileTooLargeNoLimit", { name, size }));
}

export const Media = {
  /** XMLHttpRequest because fetch reports no upload progress; the headers and session handling match `api()`. */
  uploadWithProgress: async (
    docId: string,
    file: File,
    onProgress: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<{ url: string; hash: string }> => {
    const headers = await authHeaders();
    const form = new FormData();
    form.append("file", file);
    const url = `/api/docs/${docId}/media`;

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      headers.forEach((value, name) => xhr.setRequestHeader(name, value));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        observeResponse(xhr.status, (name) => xhr.getResponseHeader(name));
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          body = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          if (body && typeof body === "object") {
            onProgress(1);
            resolve(body as { url: string; hash: string });
          } else {
            reject(new Error(t("errors.client.uploadUnreadable")));
          }
        } else {
          reject((xhr.status === 413 && tooLarge(file, body)) || failureFrom(url, "POST", xhr.status, body as Parameters<typeof failureFrom>[3]));
        }
      };
      xhr.onerror = () => reject(new Error(t("errors.client.uploadNetwork")));
      xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
      if (signal) {
        if (signal.aborted) {
          xhr.abort();
          return;
        }
        signal.addEventListener("abort", () => xhr.abort(), { once: true });
      }
      xhr.send(form);
    });
  },
};
