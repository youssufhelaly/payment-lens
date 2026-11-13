export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  messages: readonly ChatMessage[];
  tools?: readonly ToolSpec[];
  /** JSON schema the reply must conform to (structured output). */
  format?: Record<string, unknown>;
}

export interface LlmClient {
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatMessage>;
}

export class LlmUnavailableError extends Error {}

interface OllamaChatResponse {
  message?: {
    content?: string;
    tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }>;
  };
}

export class OllamaClient implements LlmClient {
  constructor(private readonly config: { baseUrl: string; model: string; timeoutMs?: number }) {}

  get model(): string {
    return this.config.model;
  }

  async chat(request: ChatRequest): Promise<ChatMessage> {
    const { baseUrl, model, timeoutMs = 300_000 } = this.config;
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: request.messages,
          tools: request.tools,
          format: request.format,
          stream: false,
          options: { temperature: 0, seed: 42 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new LlmUnavailableError(`Could not reach Ollama at ${baseUrl}. Start it with "ollama serve".`, {
        cause: err,
      });
    }

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 404 && body.includes("not found")) {
        throw new LlmUnavailableError(`Model "${model}" is not installed. Run: ollama pull ${model}`);
      }
      throw new Error(`Ollama returned HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as OllamaChatResponse;
    const toolCalls = (json.message?.tool_calls ?? [])
      .filter((call) => typeof call.function?.name === "string")
      .map((call) => ({
        function: {
          name: call.function?.name as string,
          arguments: parseToolArguments(call.function?.arguments),
        },
      }));

    return {
      role: "assistant",
      content: json.message?.content ?? "",
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }
}

export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(raw) ? raw : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
