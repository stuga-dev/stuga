import type { InternalApi } from "@stuga/runtime";

/** Actors reach the node's internal handler in-process: the request is built and handed straight to it. */
export function createInternalApi(handler: (request: Request) => Promise<Response>): InternalApi {
  return {
    async fetch(path, init) {
      if (!path.startsWith("/")) throw new TypeError(`internal path must be absolute: ${path}`);
      return handler(new Request(`http://internal${path}`, init));
    },
  };
}
