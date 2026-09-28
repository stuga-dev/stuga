/** Failures classified from the messages Pi's clients and System One actually produce, and what a person is told. */
import { describe, expect, it } from "vitest";
import { classifyFailure, failureReason, requestFailure } from "./failure.js";

describe("classifyFailure", () => {
  it.each([
    ['OpenAI API error (429): {"message":"You have no credits remaining. Add credits to continue.","type":"insufficient_quota"}', "quota"],
    ['429: {"message":"You exceeded your current quota, please check your plan and billing details.","code":"insufficient_quota"}', "quota"],
    ['400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', "quota"],
    ['429: {"message":"Your account org-xyz is suspended due to insufficient balance","type":"exceeded_current_quota_error"}', "quota"],
    ["402: Insufficient credits", "quota"],
    ['401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', "auth"],
    ['OpenAI API error (401): {"message":"Incorrect API key provided","code":"invalid_api_key"}', "auth"],
    ["systemone 403: forbidden", "auth"],
    ['429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', "rate_limit"],
    ['429: {"message":"Rate limit reached for gpt in organization org-abc on tokens per min","code":"rate_limit_exceeded"}', "rate_limit"],
    ['529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "unavailable"],
    ["503 upstream down", "unavailable"],
    ["Connection error.", "unavailable"],
    ["Request timed out.", "unavailable"],
    ["systemone network error: fetch failed", "unavailable"],
    ['404: {"message":"The model `m` does not exist","code":"model_not_found"}', "rejected"],
    ["no chat endpoint is configured", "error"],
  ])("%s → %s", (message, kind) => {
    expect(classifyFailure(message)).toBe(kind);
  });

  it("prefers a status it was given over one read from the message", () => {
    expect(classifyFailure("systemone refused", 401)).toBe("auth");
  });
});

describe("requestFailure", () => {
  it("cuts the key from the message wherever the provider echoed it", () => {
    const f = requestFailure("openai-completions", "m", "400: key sk-live-0123456789 is not valid here", { key: "sk-live-0123456789" });
    expect(f).toEqual({ kind: "rejected", protocol: "openai-completions", model: "m", message: "400: key [key] is not valid here" });
  });
});

describe("failureReason", () => {
  it("names the trouble and who can fix it, never the provider's words", () => {
    const reason = failureReason(requestFailure("openai-responses", "gpt-6-sol", "OpenAI API error (429): no credits for org-abc"));
    expect(reason).toBe("The AI provider says the account is out of credit. An administrator can check Settings → This node → AI providers.");
    expect(reason).not.toContain("org-abc");
  });

  it("has nothing plainer to say about an unclassified failure", () => {
    expect(failureReason(requestFailure(null, "m", "no chat endpoint is configured"))).toBeNull();
    expect(failureReason(undefined)).toBeNull();
  });
});
