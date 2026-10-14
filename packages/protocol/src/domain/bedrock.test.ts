import { describe, expect, it } from "vitest";
import { BEDROCK_REGION_PATTERN, bedrockRegion, bedrockRuntimeUrl, parseBedrockRuntimeUrl } from "./bedrock";

describe("bedrockRegion", () => {
  it.each([
    ["https://bedrock-runtime.us-east-1.amazonaws.com", "us-east-1"],
    ["https://bedrock-runtime.eu-central-2.amazonaws.com/", "eu-central-2"],
    ["https://BEDROCK-RUNTIME.ap-southeast-2.amazonaws.com", "ap-southeast-2"],
    ["https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com", "us-gov-west-1"],
    ["https://bedrock-runtime.cn-north-1.amazonaws.com.cn", "cn-north-1"],
  ])("%s → %s", (url, region) => {
    expect(bedrockRegion(url)).toBe(region);
  });

  it("tells the FIPS endpoint apart", () => {
    expect(parseBedrockRuntimeUrl("https://bedrock-runtime-fips.us-east-1.amazonaws.com")).toEqual({ region: "us-east-1", fips: true });
    expect(parseBedrockRuntimeUrl("https://bedrock-runtime.us-east-1.amazonaws.com")).toEqual({ region: "us-east-1", fips: false });
  });

  it.each([
    "http://bedrock-runtime.us-east-1.amazonaws.com",
    "https://bedrock-runtime.us-east-1.amazonaws.com:8443",
    "https://bedrock-runtime.us-east-1.amazonaws.com/v1",
    "https://bedrock-runtime.us-east-1.amazonaws.com/?x=1",
    "https://user:pw@bedrock-runtime.us-east-1.amazonaws.com",
    "https://bedrock.us-east-1.amazonaws.com",
    "https://bedrock-runtime.us-east-1.amazonaws.com.evil.test",
    "https://bedrock-runtime.us-east-1.amazonaws.com.",
    "https://evil.test/bedrock-runtime.us-east-1.amazonaws.com",
    "https://bedrock-runtime.not-a-region.amazonaws.com",
    "https://bedrock-runtime.us-east-1.amazonaws.com.cn",
    "https://bedrock-runtime.cn-north-1.amazonaws.com",
    "https://bedrock-runtime-fips.cn-north-1.amazonaws.com.cn",
    "https://api.anthropic.com",
    "not a url",
    "",
  ])("refuses %s", (url) => {
    expect(bedrockRegion(url)).toBeNull();
  });
});

describe("bedrockRuntimeUrl", () => {
  it("names the Region's runtime, under .com.cn in China", () => {
    expect(bedrockRuntimeUrl("us-west-2")).toBe("https://bedrock-runtime.us-west-2.amazonaws.com");
    expect(bedrockRuntimeUrl(" eu-west-3 ")).toBe("https://bedrock-runtime.eu-west-3.amazonaws.com");
    expect(bedrockRuntimeUrl("cn-northwest-1")).toBe("https://bedrock-runtime.cn-northwest-1.amazonaws.com.cn");
  });

  it("reads back as the Region it was made from", () => {
    for (const region of ["us-east-1", "us-gov-east-1", "ap-northeast-3", "cn-north-1", "il-central-1"]) {
      expect(BEDROCK_REGION_PATTERN.test(region)).toBe(true);
      expect(bedrockRegion(bedrockRuntimeUrl(region))).toBe(region);
    }
  });
});
