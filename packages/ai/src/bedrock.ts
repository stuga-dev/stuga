/**
 * Amazon Bedrock beside its runtime address: the Region the AWS client is given,
 * the control plane that lists the account's models, and a model id without the
 * routing prefix an inference profile adds.
 */
import { parseBedrockRuntimeUrl } from "@stuga/protocol/domain/bedrock";

export { bedrockRegion, bedrockRuntimeUrl } from "@stuga/protocol/domain/bedrock";

function runtimeOf(baseUrl: string) {
  const rt = parseBedrockRuntimeUrl(baseUrl);
  if (!rt) throw new Error(`${baseUrl} is not an Amazon Bedrock runtime address`);
  return rt;
}

/**
 * The Region the AWS client is given, always: it otherwise reads AWS_REGION from
 * the node's own environment. The FIPS address becomes the client's `-fips`
 * Region, which keeps requests on the FIPS endpoint.
 */
export function bedrockClientRegion(baseUrl: string): string {
  const { region, fips } = runtimeOf(baseUrl);
  return fips ? `${region}-fips` : region;
}

/** The control plane beside a runtime address, where the same key lists models. */
export function bedrockControlUrl(baseUrl: string): string {
  const { region, fips } = runtimeOf(baseUrl);
  return `https://bedrock${fips ? "-fips" : ""}.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
}

/** The geography a cross-Region inference profile routes within, leading its id. */
const ROUTING_PREFIX = /^(?:global|us|us-gov|eu|apac|au|jp|ca|in)\./;

/** `global.anthropic.claude-sonnet-5-5` → `anthropic.claude-sonnet-5-5`; any other id as it is. */
export function bedrockBaseModelId(id: string): string {
  return id.replace(ROUTING_PREFIX, "");
}
