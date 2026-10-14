/**
 * Amazon Bedrock runtime addresses. A Bedrock chat endpoint is set up by its
 * Region and stored as the runtime address of that Region, so the two convert
 * both ways; any other address is not Bedrock.
 */

/** An AWS Region code: us-east-1, eu-central-2, us-gov-west-1, cn-north-1. */
export const BEDROCK_REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d+$/;

const RUNTIME_HOST = /^bedrock-runtime(-fips)?\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?$/;

/** A runtime address read apart. */
export interface BedrockRuntime {
  region: string;
  /** The FIPS endpoint of the Region. */
  fips: boolean;
}

/**
 * `https://bedrock-runtime.<region>.amazonaws.com`, its `bedrock-runtime-fips.` twin, or the
 * `.amazonaws.com.cn` address of a Region in China; null for anything else, a path or port included.
 */
export function parseBedrockRuntimeUrl(baseUrl: string): BedrockRuntime | null {
  let u: URL;
  try {
    u = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password || u.pathname !== "/" || u.search || u.hash) return null;
  const m = RUNTIME_HOST.exec(u.hostname);
  if (!m) return null;
  const [, fips, region = "", china] = m;
  // Regions in China answer only under .com.cn, and have no FIPS endpoint.
  if (!BEDROCK_REGION_PATTERN.test(region) || region.startsWith("cn-") !== !!china || (fips && china)) return null;
  return { region, fips: !!fips };
}

/** The Region a runtime address serves, or null when the address is not one. */
export function bedrockRegion(baseUrl: string): string | null {
  return parseBedrockRuntimeUrl(baseUrl)?.region ?? null;
}

/** The runtime address of a Region. */
export function bedrockRuntimeUrl(region: string): string {
  const r = region.trim();
  return `https://bedrock-runtime.${r}.amazonaws.com${r.startsWith("cn-") ? ".cn" : ""}`;
}
