/** GET /api/agent-bundle: the installable Claude Desktop extension, offering this node's address. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mcpBundlePath } from "../setup.js";
import { download, error } from "../../http/respond.js";
import type { WorkspaceCall } from "../../http/router.js";
import type { Ctx } from "../../auth/context.js";
import { buildMcpb, bundleFilename } from "./bundle.js";
import { assertBundleEnvValue, UnsafeBundleValue } from "./manifest.js";
import { VERSION } from "../../version.js";

/** The built artifact, injectable for tests. */
export interface BundleSource {
  /** null when the server was never built. Its LICENSE and third-party-licenses.txt sit beside it. */
  bundlePath?: string | null;
  read?: (path: string) => Uint8Array;
}

export async function handleAgentBundle(ctx: Ctx, src: BundleSource = {}): Promise<Response> {
  const bundlePath = src.bundlePath !== undefined ? src.bundlePath : mcpBundlePath();
  const unavailable = () => error(503, "the agent extension is not built on this node");
  if (bundlePath === null) return unavailable();
  let serverJs: Uint8Array, license: Uint8Array, thirdPartyLicenses: Uint8Array;
  try {
    const read = src.read ?? readFileSync;
    serverJs = read(bundlePath);
    license = read(join(dirname(bundlePath), "LICENSE"));
    thirdPartyLicenses = read(join(dirname(bundlePath), "third-party-licenses.txt"));
  } catch {
    return unavailable();
  }
  try {
    assertBundleEnvValue("the node's address", ctx.env.publicOrigin);
    assertBundleEnvValue("STUGA_VERSION", VERSION);
  } catch (e) {
    if (e instanceof UnsafeBundleValue) return error(400, e.message);
    throw e;
  }
  const mcpb = buildMcpb({ serverJs, license, thirdPartyLicenses, cfg: { url: ctx.env.publicOrigin, stugaVersion: VERSION } });
  return download(mcpb, bundleFilename, "application/octet-stream");
}

export async function getAgentBundle({ ctx }: WorkspaceCall): Promise<Response> {
  return handleAgentBundle(ctx);
}
