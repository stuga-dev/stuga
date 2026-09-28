/**
 * The path every stored image and file is served at, `/api/docs/:docId/media/:hash`, the hash
 * captured first. The hash is the capability. A file's link adds the name it is saved under,
 * `…/:hash/:name`, captured second.
 */
export const MEDIA_GET_PATH = /^\/api\/docs\/[^/]+\/media\/([0-9a-f]{64})(?:\/([^/]+))?$/;

/** The image types the media store accepts. SVG never: it can carry script. */
export const SAFE_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type SafeImageMime = (typeof SAFE_IMAGE_MIMES)[number];

