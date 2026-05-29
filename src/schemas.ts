import { z } from "zod";

export const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});

export function createChatCompletionsParamsSchema<T extends string>(model: T) {
  return z.object({
    model: z.literal(model),
    messages: z.tuple([MessageSchema]).rest(MessageSchema),
    stream: z.boolean().optional(),
  });
}

export const ChatCompletionsParamsSchema = createChatCompletionsParamsSchema(
  process.env.ANTIGRAVITY_MODEL ?? "gemini-2.5-pro",
);

export type ChatCompletionsParams = z.infer<typeof ChatCompletionsParamsSchema>;
