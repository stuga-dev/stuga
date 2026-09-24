import { authHeaders, failureFrom, observeResponse } from "../lib/http/client";

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
            reject(new Error("upload succeeded but response was unreadable"));
          }
        } else {
          reject(failureFrom(url, "POST", xhr.status, body as Parameters<typeof failureFrom>[3]));
        }
      };
      xhr.onerror = () => reject(new Error("upload failed (network error)"));
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
