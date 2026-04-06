export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: unknown;
  };
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  /** Base64-encoded images for multimodal models (user messages only). */
  images?: string[];
}

export interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface OllamaToolResultEnvelope {
  ok: boolean;
  tool_name: string;
  tool_kind: 'http' | 'browser';
  format: 'json' | 'text';
  data?: unknown;
  error?: {
    message: string;
    code?: string;
    category?: string;
    details?: Record<string, unknown>;
  };
  duration_ms: number;
}

export interface OllamaChatResponse {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  error?: string;
}
