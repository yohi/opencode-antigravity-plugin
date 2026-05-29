import { z } from "zod";

export const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1),
});

export function createChatCompletionsParamsSchema<T extends string>(model: T) {
  return z.object({
    model: z.literal(model),
    messages: z.tuple([MessageSchema]).rest(MessageSchema),
    stream: z.boolean().optional(),
  });
}

/**
 * Returns a schema instance based on the current ANTIGRAVITY_MODEL environment variable.
 * Use this getter instead of a constant to ensure environment changes are reflected.
 */
export function getChatCompletionsParamsSchema() {
  const model = (process.env.ANTIGRAVITY_MODEL ?? "").trim();
  return createChatCompletionsParamsSchema(
    model || "gemini-2.5-pro",
  );
}

/** @deprecated Use {@link getChatCompletionsParamsSchema} instead. */
export const ChatCompletionsParamsSchema = getChatCompletionsParamsSchema();

export type ChatCompletionsParams = z.infer<typeof ChatCompletionsParamsSchema>;
