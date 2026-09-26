/**
 * How the node signs people in and what it is called (GET /auth/config),
 * fetched once before the first render. The node's own username + password accounts are always
 * offered, and after the first one an account is created only with an invite
 * link. An administrator may add one identity provider beside them, which the
 * node talks to itself: the browser only follows the addresses it hands out.
 */
/** The node's colour, which marks the selected item; null means not set. */
export interface BrandingConfig {
  accentColor: string | null;
}

export interface AuthClientConfig {
  /** The identity provider offered beside passwords; null when none is configured. */
  provider: { label: string } | null;
  /** No account yet: the first one to register administers the node. */
  unclaimed: boolean;
  /** The name an administrator gave the node, shown in place of the product's; null until there is one. */
  nodeName: string | null;
  /** What tells this node apart from others: its name, else its host. Null only when the config could not be fetched. */
  nodeLabel: string | null;
  /** The address the node knows itself by; null only when the config could not be fetched. */
  origin: string | null;
  branding: BrandingConfig;
}

interface AuthConfigResponse {
  provider?: { label?: string } | null;
  unclaimed?: boolean;
  node_name?: string | null;
  node_label?: string | null;
  origin?: string | null;
  branding?: { accent_color?: string | null } | null;
}

/**
 * Assumed when /auth/config cannot be fetched: sign-in still renders, and each
 * attempt reports its own failure instead of the page going blank.
 */
const FALLBACK_CONFIG: AuthClientConfig = {
  provider: null,
  unclaimed: false,
  nodeName: null,
  nodeLabel: null,
  origin: null,
  branding: { accentColor: null },
};

let cachedConfig: AuthClientConfig | null = null;
let configFailed = false;

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function parseConfig(raw: AuthConfigResponse): AuthClientConfig {
  const label = raw.provider?.label?.trim();
  return {
    provider: label ? { label } : null,
    unclaimed: raw.unclaimed === true,
    nodeName: text(raw.node_name),
    nodeLabel: text(raw.node_label),
    origin: text(raw.origin),
    branding: { accentColor: raw.branding?.accent_color ?? null },
  };
}

/**
 * Fetch and cache the config. Never rejects. A failed first load installs the
 * fallback and is remembered; a failed reload keeps what an earlier one read,
 * which says more about this node than the fallback does.
 */
export async function loadAuthConfig(): Promise<void> {
  try {
    const res = await fetch("/auth/config", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`auth config → ${res.status}`);
    cachedConfig = parseConfig((await res.json()) as AuthConfigResponse);
    configFailed = false;
  } catch {
    if (cachedConfig) return;
    cachedConfig = FALLBACK_CONFIG;
    configFailed = true;
  }
}

export function authConfig(): AuthClientConfig {
  return cachedConfig ?? FALLBACK_CONFIG;
}

export function brandingConfig(): BrandingConfig {
  return authConfig().branding;
}

/** Replace the cached branding after a node administrator saves new branding. */
export function setBrandingConfig(branding: BrandingConfig): void {
  cachedConfig = { ...authConfig(), branding };
}

/** Replace the cached name and label after a node administrator renames the node. */
export function setNodeNameConfig(node: { name: string | null; label: string }): void {
  cachedConfig = { ...authConfig(), nodeName: node.name, nodeLabel: node.label };
}

/** True when /auth/config could not be fetched and the fallback is in force. */
export function authConfigUnavailable(): boolean {
  return configFailed;
}

/** Only the parts a test names; the rest are the fallback's. Null forgets the config, as before the first load. */
export function setAuthConfigForTest(cfg: Partial<AuthClientConfig> | null): void {
  cachedConfig = cfg ? { ...FALLBACK_CONFIG, ...cfg } : null;
  configFailed = false;
}

/** The identity provider's button text, or null when the node offers none. */
export function providerLabel(): string | null {
  return authConfig().provider?.label ?? null;
}

/** True while this node has no account, so the visitor is setting it up rather than signing in. */
export function nodeUnclaimed(): boolean {
  return authConfig().unclaimed;
}
