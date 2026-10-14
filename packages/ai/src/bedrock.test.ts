/** The AWS client's Region, the control plane and the bare model id, from a Bedrock runtime address. */
import { describe, expect, it } from "vitest";
import { bedrockBaseModelId, bedrockClientRegion, bedrockControlUrl, bedrockRegion, bedrockRuntimeUrl } from "./bedrock.js";

describe("bedrockClientRegion", () => {
  it("names the address's Region, and keeps a FIPS address on the FIPS endpoint", () => {
    expect(bedrockClientRegion("https://bedrock-runtime.us-west-2.amazonaws.com")).toBe("us-west-2");
    expect(bedrockClientRegion("https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com")).toBe("us-gov-west-1-fips");
    expect(bedrockClientRegion("https://bedrock-runtime.cn-north-1.amazonaws.com.cn")).toBe("cn-north-1");
  });

  it("refuses any other address", () => {
    expect(() => bedrockClientRegion("https://proxy.example.test")).toThrow(/not an Amazon Bedrock runtime address/);
  });
});

describe("bedrockControlUrl", () => {
  it.each([
    ["https://bedrock-runtime.us-west-2.amazonaws.com", "https://bedrock.us-west-2.amazonaws.com"],
    ["https://bedrock-runtime-fips.us-east-1.amazonaws.com", "https://bedrock-fips.us-east-1.amazonaws.com"],
    ["https://bedrock-runtime.cn-northwest-1.amazonaws.com.cn", "https://bedrock.cn-northwest-1.amazonaws.com.cn"],
  ])("%s → %s", (runtime, control) => {
    expect(bedrockControlUrl(runtime)).toBe(control);
  });

  it("refuses any other address", () => {
    expect(() => bedrockControlUrl("https://bedrock-runtime.us-west-2.amazonaws.com.evil.test")).toThrow();
  });
});

describe("bedrockBaseModelId", () => {
  it.each([
    ["global.anthropic.claude-sonnet-5-5", "anthropic.claude-sonnet-5-5"],
    ["us-gov.anthropic.claude-sonnet-5-5", "anthropic.claude-sonnet-5-5"],
    ["apac.amazon.nova-pro-v1:0", "amazon.nova-pro-v1:0"],
    ["anthropic.claude-sonnet-5-5", "anthropic.claude-sonnet-5-5"],
    ["arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3", "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3"],
  ])("%s → %s", (id, base) => {
    expect(bedrockBaseModelId(id)).toBe(base);
  });
});

describe("re-exported for the node", () => {
  it("converts a Region and its runtime address both ways", () => {
    expect(bedrockRegion(bedrockRuntimeUrl("eu-north-1"))).toBe("eu-north-1");
  });
});
