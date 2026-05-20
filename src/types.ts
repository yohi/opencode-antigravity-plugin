export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
}

export interface OpenAIChatChoice {
  index: number;
  message: OpenAIChatMessage;
  finish_reason: "stop" | "length" | "content_filter";
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  model: string;
  choices: OpenAIChatChoice[];
}
