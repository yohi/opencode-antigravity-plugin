import { afterEach, describe, expect, it } from "vitest";
import { createChatCompletionsParamsSchema, getChatCompletionsParamsSchema } from "../../src/schemas.js";

const schema = createChatCompletionsParamsSchema("gemini-2.5-pro");

describe("getChatCompletionsParamsSchema", () => {
  const originalEnv = process.env.ANTIGRAVITY_MODEL;

  afterEach(() => {
    process.env.ANTIGRAVITY_MODEL = originalEnv;
  });

  it("uses default model when ANTIGRAVITY_MODEL is unset", () => {
    delete process.env.ANTIGRAVITY_MODEL;
    const s = getChatCompletionsParamsSchema();
    const result = s.safeParse({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.success).toBe(true);
  });

  it("uses specific model when ANTIGRAVITY_MODEL is set", () => {
    process.env.ANTIGRAVITY_MODEL = "custom-model";
    const s = getChatCompletionsParamsSchema();
    const result = s.safeParse({
      model: "custom-model",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.success).toBe(true);
  });

  it("uses default model when ANTIGRAVITY_MODEL is empty string", () => {
    process.env.ANTIGRAVITY_MODEL = "  ";
    const s = getChatCompletionsParamsSchema();
    const result = s.safeParse({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.success).toBe(true);
  });
});

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

  it("rejects empty message content", () => {
    const result = schema.safeParse({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts multiple messages", () => {
    const result = schema.safeParse({
      model: "gemini-2.5-pro",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hi" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing model field", () => {
    const result = schema.safeParse({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts explicitly undefined stream", () => {
    const result = schema.safeParse({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: undefined,
    });
    expect(result.success).toBe(true);
  });

  it("accepts omitted stream field", () => {
    const result = schema.safeParse({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.success).toBe(true);
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
