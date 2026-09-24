import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The app tree this node runs from: the monorepo root in a checkout, the copied app in packaging. */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
