import { z } from "zod";

const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});

export function createChatCompletionsParamsSchema(model: string) {
  return z.object({
    model: z.literal(model),
    messages: z.array(MessageSchema).nonempty(),
    stream: z.boolean().optional(),
  });
}

export const ChatCompletionsParamsSchema = createChatCompletionsParamsSchema(
  process.env.ANTIGRAVITY_MODEL ?? "gemini-2.5-pro",
);

export type ChatCompletionsParams = z.infer<typeof ChatCompletionsParamsSchema>;
