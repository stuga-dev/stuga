/** POST /api/agent-bundle: mint a key and hand it back inside an installable extension. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mcpBundlePath } from "../setup.js";
import { createAgentKey } from "../keys.js";
import { download, error } from "../../http/respond.js";
import type { WorkspaceCall } from "../../http/router.js";
import type { Ctx } from "../../auth/context.js";
import { buildMcpb, bundleFilename } from "./bundle.js";
import { assertBundleEnvValue, UnsafeBundleValue } from "./manifest.js";
import { guestForbidden } from "../../authz/authz.js";
import { VERSION } from "../../version.js";

/** The key name an unnamed extension is minted under. */
const DEFAULT_NAME = "Claude Desktop";

/** The built artifact and the clock, injectable for tests. */
export interface BundleSource {
  /** null when the server was never built. Its LICENSE and third-party-licenses.txt sit beside it. */
  bundlePath?: string | null;
  read?: (path: string) => Uint8Array;
  now?: () => Date;
}

export async function handleAgentBundle(ctx: Ctx, req: Request, src: BundleSource = {}): Promise<Response> {
  // The same gates as POST /api/keys: this download carries a live credential.
  if (ctx.isAgent) return error(403, "agents cannot manage api keys");
  const guest = guestForbidden(ctx, "manage api keys");
  if (guest) return guest;

  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const name = (body.name ?? "").trim().slice(0, 100) || DEFAULT_NAME;

  const bundlePath = src.bundlePath !== undefined ? src.bundlePath : mcpBundlePath();
  const unavailable = () => error(503, "the agent extension is not built on this node");
  if (bundlePath === null) return unavailable();

  // Everything that can fail runs before the mint: an undelivered key is a live credential nobody holds.
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
    assertBundleEnvValue("STUGA_URL", ctx.env.publicOrigin);
    assertBundleEnvValue("STUGA_VERSION", VERSION);
  } catch (e) {
    if (e instanceof UnsafeBundleValue) return error(400, e.message);
    throw e;
  }

  const nodeName = ctx.env.settings.current().nodeLabel;
  const key = await createAgentKey(ctx, name);
  const mcpb = buildMcpb({
    serverJs,
    license,
    thirdPartyLicenses,
    cfg: {
      url: ctx.env.publicOrigin,
      nodeId: ctx.env.nodeId,
      nodeName,
      token: key.token,
      workspace: ctx.workspaceId,
      stugaVersion: VERSION,
    },
    now: src.now?.() ?? new Date(),
  });
  return download(mcpb, bundleFilename, "application/octet-stream");
}

export async function createAgentBundle({ ctx, req }: WorkspaceCall): Promise<Response> {
  return handleAgentBundle(ctx, req);
}
