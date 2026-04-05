import type {
  AgentProvider,
  AgentProviderConfig,
  AgentRunParams,
  AgentRunResult,
  AgentEvent,
  AgentFrameworkConfig,
  AgentToolSpec,
} from "../types";
import { z } from "zod";
import { createLogger } from "../../services/logger";

const log = createLogger("openai-compatible-agent");

type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type CapabilityStatus = { ok: true } | { ok: false; message: string };

const CAPABILITY_TTL_MS = 30_000;

export class OpenAICompatibleAgentProvider implements AgentProvider {
  readonly config: AgentProviderConfig = {
    id: "openai-compatible",
    name: "OpenAI-Compatible Agent",
    description: "Local/hosted OpenAI-compatible endpoint with streaming tool calls",
    auth: { type: "api_key", configKey: "OPENAI_COMPATIBLE_API_KEY" },
  };

  private frameworkConfig: AgentFrameworkConfig;
  private controllers = new Map<string, AbortController>();
  private capabilityCache: { at: number; status: CapabilityStatus } | null = null;

  constructor(frameworkConfig: AgentFrameworkConfig) {
    this.frameworkConfig = frameworkConfig;
  }

  async isAvailable(): Promise<boolean> {
    const endpoint = this.getEndpoint();
    if (!endpoint) return false;

    const cap = await this.checkCapabilities(endpoint.baseUrl, endpoint.apiKey);
    if (!cap.ok) {
      log.warn(`[OpenAICompatibleAgent] Unavailable: ${cap.message}`);
      return false;
    }
    return true;
  }

  updateConfig(config: Partial<AgentFrameworkConfig>): void {
    this.frameworkConfig = { ...this.frameworkConfig, ...config };
    this.capabilityCache = null;
  }

  cancel(taskId: string): void {
    const ctrl = this.controllers.get(taskId);
    if (ctrl) {
      ctrl.abort();
      this.controllers.delete(taskId);
    }
  }

  async *run(params: AgentRunParams): AsyncGenerator<AgentEvent, AgentRunResult, void> {
    const endpoint = this.getEndpoint();
    if (!endpoint) {
      const message =
        "OpenAI-compatible endpoint is not configured. Set base URL in Settings -> General.";
      yield { type: "error", message };
      return { state: "failed" };
    }

    const capability = await this.checkCapabilities(endpoint.baseUrl, endpoint.apiKey);
    if (!capability.ok) {
      yield { type: "error", message: capability.message };
      return { state: "failed" };
    }

    const taskController = new AbortController();
    this.controllers.set(params.taskId, taskController);
    const signal = AbortSignal.any([params.signal, taskController.signal]);
    const model = params.modelOverride ?? this.frameworkConfig.model;

    yield { type: "state", state: "running" };

    const messages: Array<Record<string, unknown>> = [
      {
        role: "system",
        content: buildSystemPrompt(params.context, params.tools),
      },
      {
        role: "user",
        content: params.prompt,
      },
    ];

    try {
      for (let turn = 0; turn < 24; turn++) {
        let completion: { text: string; toolCalls: OpenAiToolCall[] } | null = null;
        for await (const streamEvent of this.streamCompletion({
          endpoint,
          model,
          messages,
          tools: params.tools,
          signal,
        })) {
          if (streamEvent.type === "text_delta") {
            yield { type: "text_delta", text: streamEvent.text };
          } else {
            completion = { text: streamEvent.text, toolCalls: streamEvent.toolCalls };
          }
        }
        if (!completion) {
          throw new Error("OpenAI-compatible endpoint returned no completion result");
        }

        if (completion.text) {
          // Already streamed above; keep summary at the end only.
        }

        if (completion.toolCalls.length === 0) {
          yield { type: "done", summary: completion.text?.trim() || "Completed" };
          return { state: "completed" };
        }

        const normalizedToolCalls = completion.toolCalls.map((tc, index) => ({
          ...tc,
          id: tc.id || `${tc.function.name || "tool"}-${Date.now()}-${index}`,
        }));

        const assistantMessage: Record<string, unknown> = {
          role: "assistant",
          content: completion.text || "",
          tool_calls: normalizedToolCalls,
        };
        messages.push(assistantMessage);

        for (const toolCall of normalizedToolCalls) {
          const toolName = toolCall.function.name;
          const toolCallId = toolCall.id;
          const parsedArgs = tryParseJson(toolCall.function.arguments);

          yield {
            type: "tool_call_start",
            toolName,
            toolCallId,
            input: parsedArgs,
          };

          let toolResult: unknown;
          try {
            toolResult = await params.toolExecutor(toolName, asRecord(parsedArgs));
          } catch (error) {
            toolResult = {
              error: error instanceof Error ? error.message : String(error),
            };
          }

          yield {
            type: "tool_call_end",
            toolCallId,
            result: toolResult,
          };

          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: JSON.stringify(toolResult),
          });
        }
      }

      yield {
        type: "error",
        message: "OpenAI-compatible agent reached turn limit without finishing.",
      };
      return { state: "failed" };
    } catch (error) {
      if (signal.aborted) {
        yield { type: "state", state: "cancelled" };
        return { state: "cancelled" };
      }
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", message };
      return { state: "failed" };
    } finally {
      this.controllers.delete(params.taskId);
    }
  }

  private async *streamCompletion(params: {
    endpoint: { baseUrl: string; apiKey?: string };
    model: string;
    messages: Array<Record<string, unknown>>;
    tools: AgentToolSpec[];
    signal: AbortSignal;
  }): AsyncGenerator<
    | { type: "text_delta"; text: string }
    | { type: "result"; text: string; toolCalls: OpenAiToolCall[] }
  > {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (params.endpoint.apiKey) {
      headers.Authorization = `Bearer ${params.endpoint.apiKey}`;
    }

    const body = {
      model: params.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: params.messages,
      tools: params.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: toOpenAiJsonSchema(tool),
        },
      })),
      tool_choice: "auto",
    };

    const resp = await fetch(`${params.endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: params.signal,
      body: JSON.stringify(body),
    });

    if (!resp.ok || !resp.body) {
      const raw = await resp.text().catch(() => "");
      throw new Error(raw || `OpenAI-compatible stream failed (${resp.status})`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const toolCallsByIndex = new Map<number, OpenAiToolCall>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary === -1) break;
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const line = chunk
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.startsWith("data:"));
        if (!line) continue;

        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let json: Record<string, unknown>;
        try {
          json = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }

        const choice = Array.isArray(json.choices) ? (json.choices[0] as Record<string, unknown>) : undefined;
        const delta = (choice?.delta as Record<string, unknown> | undefined) ?? undefined;
        const deltaText = typeof delta?.content === "string" ? delta.content : "";
        if (deltaText) {
          text += deltaText;
          yield { type: "text_delta", text: deltaText };
        }

        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
            const index = typeof tc.index === "number" ? tc.index : 0;
            const existing = toolCallsByIndex.get(index) ?? {
              id: "",
              type: "function" as const,
              function: { name: "", arguments: "" },
            };
            if (typeof tc.id === "string") existing.id = tc.id;
            const fn = tc.function as Record<string, unknown> | undefined;
            if (fn) {
              if (typeof fn.name === "string") existing.function.name = fn.name;
              if (typeof fn.arguments === "string") {
                existing.function.arguments += fn.arguments;
              }
            }
            toolCallsByIndex.set(index, existing);
          }
        }
      }
    }

    yield { type: "result", text, toolCalls: [...toolCallsByIndex.values()] };
  }

  private getEndpoint(): { baseUrl: string; apiKey?: string } | null {
    if (this.frameworkConfig.llmBackend !== "openai_compatible") return null;
    const cfg = this.frameworkConfig.openaiCompatible;
    if (!cfg?.baseUrl) return null;
    return {
      baseUrl: cfg.baseUrl.replace(/\/+$/, ""),
      apiKey: cfg.apiKey?.trim() || undefined,
    };
  }

  private async checkCapabilities(baseUrl: string, apiKey?: string): Promise<CapabilityStatus> {
    if (
      this.capabilityCache &&
      Date.now() - this.capabilityCache.at < CAPABILITY_TTL_MS &&
      this.capabilityCache.status
    ) {
      return this.capabilityCache.status;
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    try {
      const streamResp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.frameworkConfig.model,
          stream: true,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (!streamResp.ok) {
        const text = await streamResp.text().catch(() => "");
        const status: CapabilityStatus = {
          ok: false,
          message: `Streaming unsupported by endpoint: ${text || `HTTP ${streamResp.status}`}`,
        };
        this.capabilityCache = { at: Date.now(), status };
        return status;
      }

      const toolsResp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.frameworkConfig.model,
          max_tokens: 8,
          messages: [{ role: "user", content: "Call the capability_probe tool." }],
          tools: [
            {
              type: "function",
              function: {
                name: "capability_probe",
                description: "Capability probe tool",
                parameters: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "capability_probe" } },
        }),
      });
      if (!toolsResp.ok) {
        const text = await toolsResp.text().catch(() => "");
        const status: CapabilityStatus = {
          ok: false,
          message: `Tool-calling unsupported by endpoint: ${text || `HTTP ${toolsResp.status}`}`,
        };
        this.capabilityCache = { at: Date.now(), status };
        return status;
      }

      const payload = (await toolsResp.json()) as Record<string, unknown>;
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const first = choices[0] as Record<string, unknown> | undefined;
      const message = first?.message as Record<string, unknown> | undefined;
      const toolCalls = message?.tool_calls;
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        const status: CapabilityStatus = {
          ok: false,
          message:
            "Endpoint did not return a tool call. Choose a model that supports function calling.",
        };
        this.capabilityCache = { at: Date.now(), status };
        return status;
      }

      const status: CapabilityStatus = { ok: true };
      this.capabilityCache = { at: Date.now(), status };
      return status;
    } catch (error) {
      const status: CapabilityStatus = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
      this.capabilityCache = { at: Date.now(), status };
      return status;
    }
  }
}

function buildSystemPrompt(context: AgentRunParams["context"], tools: AgentToolSpec[]): string {
  const parts: string[] = [
    "You are Exo's email assistant. Use tools when needed and keep responses concise.",
    `User: ${context.userName || "Unknown"} <${context.userEmail}>`,
    `Account ID: ${context.accountId}`,
  ];
  if (context.currentEmailId) parts.push(`Current email ID: ${context.currentEmailId}`);
  if (context.currentThreadId) parts.push(`Current thread ID: ${context.currentThreadId}`);
  if (context.currentDraftId) parts.push(`Current draft ID: ${context.currentDraftId}`);
  if (context.emailSubject) parts.push(`Email subject: ${context.emailSubject}`);
  if (context.emailFrom) parts.push(`Email from: ${context.emailFrom}`);
  if (context.emailTo) parts.push(`Email to: ${context.emailTo}`);
  if (context.emailBody) parts.push(`Email body:\n${context.emailBody}`);
  if (context.memoryContext) parts.push(`Memory context:\n${context.memoryContext}`);

  const toolGuidance = tools
    .map((t) => t.systemPromptGuidance)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (toolGuidance.length > 0) {
    parts.push("Tool guidance:");
    parts.push(...toolGuidance);
  }
  return parts.join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonSchema(item));
  }
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "$schema" || key === "$id") continue;
    out[key] = sanitizeJsonSchema(nested);
  }
  return out;
}

export function toOpenAiJsonSchema(tool: AgentToolSpec): Record<string, unknown> {
  try {
    const jsonSchema = sanitizeJsonSchema(z.toJSONSchema(tool.inputSchema));
    if (isRecord(jsonSchema) && jsonSchema.type === "object") {
      if (!("additionalProperties" in jsonSchema)) {
        jsonSchema.additionalProperties = true;
      }
      return jsonSchema;
    }
  } catch (err) {
    log.warn(
      { err: err },
      `[OpenAICompatibleAgent] Failed to convert tool schema for ${tool.name}, using fallback.`,
    );
  }
  return { type: "object", additionalProperties: true };
}

function tryParseJson(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
