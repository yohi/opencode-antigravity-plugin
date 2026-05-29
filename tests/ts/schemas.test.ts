import { describe, expect, it } from "vitest";
import { createChatCompletionsParamsSchema } from "../../src/schemas.js";

const schema = createChatCompletionsParamsSchema("gemini-2.5-pro");

describe("ChatCompletionsParamsSchema (Phase A)", () => {
  it("accepts a valid request", () => {
    const result = schema.safeParse({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty messages", () => {
    const result = schema.safeParse({
      model: "gemini-2.5-pro",
      messages: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects model mismatch", () => {
    const result = schema.safeParse({
      model: "wrong-model",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects stream of wrong type", () => {
    const result = schema.safeParse({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: "true",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid role", () => {
    const result = schema.safeParse({
      model: "gemini-2.5-pro",
      messages: [{ role: "function", content: "hi" }],
    });
    expect(result.success).toBe(false);
  });

  it("factory builds schemas for different models", () => {
    const flash = createChatCompletionsParamsSchema("gemini-2.5-flash");
    const valid = flash.safeParse({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(valid.success).toBe(true);

    const invalid = flash.safeParse({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(invalid.success).toBe(false);
  });
});
