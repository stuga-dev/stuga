/**
 * Asking the machine to install a newer release, where the packaging has a helper that can (the
 * Mac package's, which runs as root): the node drops the version into the helper's requests
 * directory, and reads how it went from the file the helper writes. The node never installs
 * anything itself, and the helper takes nothing from the request but a version, installing only
 * a package that release published and that Apple notarized under Stuga's team.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface UpgradeHelper {
  requests: string;
  status: string;
}

export interface InstallStatus {
  version: string;
  state: "downloading" | "verifying" | "installing" | "done" | "failed" | "refused";
  message: string;
  at: string;
}

const STATES = new Set<InstallStatus["state"]>(["downloading", "verifying", "installing", "done", "failed", "refused"]);

/** What the helper last reported, or null before it has reported anything readable. */
export async function readInstallStatus(helper: UpgradeHelper): Promise<InstallStatus | null> {
  const text = await readFile(helper.status, "utf8").catch(() => null);
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw.state !== "string" || !STATES.has(raw.state as InstallStatus["state"])) return null;
    return {
      version: typeof raw.version === "string" ? raw.version : "",
      state: raw.state as InstallStatus["state"],
      message: typeof raw.message === "string" ? raw.message : "",
      at: typeof raw.at === "string" ? raw.at : "",
    };
  } catch {
    return null;
  }
}

/** Ask for `version`, a release version the caller checked. Written whole and renamed in, so the helper never reads half of it. */
export async function requestInstall(helper: UpgradeHelper, version: string): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a release version: ${version}`);
  const tmp = join(helper.requests, `.upgrade.${process.pid}.tmp`);
  await writeFile(tmp, `${version}\n`, { mode: 0o640 });
  await rename(tmp, join(helper.requests, "upgrade"));
}
