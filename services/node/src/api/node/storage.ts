/** `/api/node/storage`: what the node takes on disk, and what is left. */
import { databaseBytes } from "@stuga/db";
import { json } from "../../http/respond.js";
import type { WorkspaceCall } from "../../http/router.js";
import { directoryBytes, freeBytes } from "../../ops/tools.js";

export async function getNodeStorage({ ctx }: WorkspaceCall): Promise<Response> {
  const backups = ctx.env.backups ? await ctx.env.backups.list() : null;
  const [database, files, free] = await Promise.all([
    databaseBytes(ctx.sql),
    directoryBytes(ctx.env.dataDir),
    freeBytes(ctx.env.dataDir),
  ]);
  return json({
    database_bytes: database,
    // The data directory: documents' and databases' own files, media and the node's keys.
    files_bytes: files,
    // This node's complete backups; null when it takes none of itself.
    backups_bytes: backups ? backups.reduce((sum, b) => sum + b.bytes, 0) : null,
    // On the disk that holds the data directory.
    free_bytes: free,
  });
}
