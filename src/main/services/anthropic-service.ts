/**
 * AnthropicService — Central wrapper for all Claude API calls.
 *
 * Three responsibilities:
 * 1. WRAP — Thin wrapper around anthropic.messages.create()
 * 2. RETRY — Exponential backoff on transient errors (non-blocking async setTimeout)
 * 3. RECORD — Every call logged to llm_calls table for cost tracking
 *
 * REDACTION: Never records email body/subject. Only IDs and metadata.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsNonStreaming,
  Message,
} from "@anthropic-ai/sdk/resources/messages";
import { createLogger } from "./logger";
import { randomUUID } from "crypto";
import type { LlmBackend, OpenAICompatibleConfig } from "../../shared/types";

const log = createLogger("anthropic");

// Approximate pricing per million tokens. Last updated: 2026-03-29.
// These are approximate and will drift as Anthropic updates pricing.
// TODO: Make updatable without code changes (config file or API).
const PRICING: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "claude-opus-4-20250514": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-6": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  // Older model IDs that may still be in use
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
};

// Default pricing for unknown models (use Sonnet pricing as a reasonable middle)
const DEFAULT_PRICING = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };

interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

const RETRY_CONFIGS: Record<string, RetryConfig> = {
  rate_limit: { maxRetries: 5, initialDelayMs: 1000, maxDelayMs: 30000 },
  server_error: { maxRetries: 3, initialDelayMs: 2000, maxDelayMs: 30000 },
  connection: { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 10000 },
};

export interface LlmCallRecord {
  id: string;
  created_at: string;
  model: string;
  caller: string;
  email_id: string | null;
  account_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cost_cents: number;
  duration_ms: number;
  success: number;
  error_message: string | null;
}

export interface UsageStats {
  today: { totalCostCents: number; totalCalls: number };
  thisWeek: { totalCostCents: number; totalCalls: number };
  thisMonth: { totalCostCents: number; totalCalls: number };
  byModel: Array<{ model: string; costCents: number; calls: number }>;
  byCaller: Array<{ caller: string; costCents: number; calls: number }>;
}

interface CreateOptions {
  /** Which service is making this call, for cost attribution */
  caller: string;
  /** Optional email ID for tracing */
  emailId?: string;
  /** Optional account ID for attribution */
  accountId?: string;
  /** Timeout in milliseconds (default: none) */
  timeoutMs?: number;
}

type LlmRuntimeConfig = {
  llmBackend: LlmBackend;
  openaiCompatible?: OpenAICompatibleConfig;
};

let _llmRuntimeConfig: LlmRuntimeConfig = { llmBackend: "anthropic" };

export function setLlmRuntimeConfig(config: Partial<LlmRuntimeConfig>): void {
  _llmRuntimeConfig = { ..._llmRuntimeConfig, ...config };
}

export function getLlmRuntimeConfig(): LlmRuntimeConfig {
  return _llmRuntimeConfig;
}

// Anthropic client — singleton for production, replaceable for testing
let _anthropicClient: Anthropic | null = null;
let _defaultClient: Anthropic | null = null;
let _openaiCompatibleClient: Anthropic | null = null;
let _openaiFetch: typeof fetch = fetch;

class OpenAICompatibleError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "OpenAICompatibleError";
    this.status = status;
  }
}

/**
 * Replace the Anthropic client for testing. Pass null to reset.
 * The mock must have a `messages.create()` method matching the SDK.
 */
export function _setClientForTesting(client: unknown): void {
  _anthropicClient = client as Anthropic;
}

export function _setOpenAIFetchForTesting(fetchImpl: typeof fetch): void {
  _openaiFetch = fetchImpl;
}

/**
 * Reset the cached default client, forcing a fresh Anthropic() on next call.
 * Call this when the API key changes (e.g. via Settings).
 */
export function resetClient(): void {
  _defaultClient = null;
  _openaiCompatibleClient = null;
}

export function getClient(): Anthropic {
  if (_anthropicClient) return _anthropicClient;
  if (shouldUseOpenAICompatibleBackend()) {
    if (!_openaiCompatibleClient) {
      _openaiCompatibleClient = {
        messages: {
          create: async (params: MessageCreateParamsNonStreaming) =>
            createMessageViaOpenAICompatible(params, { caller: "openai-compatible-direct" }),
          stream: (params: MessageCreateParamsNonStreaming) => ({
            finalMessage: async () =>
              createMessageViaOpenAICompatible(params, { caller: "openai-compatible-stream" }),
          }),
        },
      } as unknown as Anthropic;
    }
    return _openaiCompatibleClient;
  }
  if (!_defaultClient) _defaultClient = new Anthropic();
  return _defaultClient;
}

function shouldUseOpenAICompatibleBackend(): boolean {
  return _llmRuntimeConfig.llmBackend === "openai_compatible";
}

function getOpenAICompatibleEndpoint():
  | { baseUrl: string; apiKey?: string }
  | null {
  const cfg = _llmRuntimeConfig.openaiCompatible;
  if (!cfg?.baseUrl) return null;
  return {
    baseUrl: cfg.baseUrl.replace(/\/+$/, ""),
    apiKey: cfg.apiKey?.trim() || undefined,
  };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block && "text" in block) {
      const typed = block as { type?: unknown; text?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") {
        parts.push(typed.text);
      }
    }
  }
  return parts.join("\n");
}

function systemToText(system: MessageCreateParamsNonStreaming["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((block) => (block?.type === "text" ? block.text : ""))
    .filter((v) => typeof v === "string" && v.length > 0)
    .join("\n\n");
}

function buildOpenAICompatibleMessages(
  params: MessageCreateParamsNonStreaming,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  const systemText = systemToText(params.system);
  if (systemText) {
    messages.push({ role: "system", content: systemText });
  }
  for (const msg of params.messages) {
    if (msg.role === "user" || msg.role === "assistant") {
      messages.push({ role: msg.role, content: contentToText(msg.content) });
    }
  }
  return messages;
}

async function createMessageViaOpenAICompatible(
  params: MessageCreateParamsNonStreaming,
  options: CreateOptions,
  attemptSignal?: AbortSignal,
): Promise<Message> {
  const endpoint = getOpenAICompatibleEndpoint();
  if (!endpoint) {
    throw new OpenAICompatibleError(
      "OpenAI-compatible backend selected but base URL is not configured.",
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (endpoint.apiKey) {
    headers.Authorization = `Bearer ${endpoint.apiKey}`;
  }

  const signals: AbortSignal[] = [];
  if (attemptSignal) signals.push(attemptSignal);
  if (options.timeoutMs) signals.push(AbortSignal.timeout(options.timeoutMs));
  const signal = signals.length === 0 ? undefined : AbortSignal.any(signals);

  const body = {
    model: params.model,
    max_tokens: params.max_tokens,
    temperature: params.temperature,
    messages: buildOpenAICompatibleMessages(params),
  };

  const response = await _openaiFetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let message = `OpenAI-compatible request failed (${response.status})`;
    try {
      const payload = (await response.json()) as {
        error?: { message?: string } | string;
        message?: string;
      };
      const detailed =
        typeof payload.error === "string"
          ? payload.error
          : payload.error?.message || payload.message || "";
      if (detailed) message = detailed;
    } catch {
      const text = await response.text().catch(() => "");
      if (text) message = text.slice(0, 400);
    }
    throw new OpenAICompatibleError(message, response.status);
  }

  const payload = (await response.json()) as {
    id?: string;
    model?: string;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const text = contentToText(payload.choices?.[0]?.message?.content);
  const usage = payload.usage ?? {};

  return {
    id: payload.id ?? randomUUID(),
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: payload.model ?? params.model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  } as Message;
}

// Database handle — set via setDatabase() during app init
type DatabaseInstance = {
  prepare: (sql: string) => {
    run: (...args: unknown[]) => void;
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
  };
  exec: (sql: string) => void;
  transaction: <T>(fn: () => T) => () => T;
};

let _db: DatabaseInstance | null = null;
let _insertStmt: ReturnType<DatabaseInstance["prepare"]> | null = null;

/**
 * Set the database handle for recording LLM calls.
 * Must be called after initDatabase() during app startup.
 */
export function setAnthropicServiceDb(db: DatabaseInstance): void {
  _db = db;
  // Ensure llm_calls table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_calls (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      model TEXT NOT NULL,
      caller TEXT NOT NULL,
      email_id TEXT,
      account_id TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_create_tokens INTEGER DEFAULT 0,
      cost_cents REAL NOT NULL,
      duration_ms INTEGER NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_caller ON llm_calls(caller);
  `);
  _insertStmt = db.prepare(`
    INSERT INTO llm_calls (id, model, caller, email_id, account_id,
      input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
      cost_cents, duration_ms, success, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

function calculateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
): number {
  const pricing = PRICING[model] || DEFAULT_PRICING;
  // input_tokens from the API already excludes cache tokens — they're separate fields
  const inputCost = (inputTokens * pricing.input) / 1_000_000;
  const outputCost = (outputTokens * pricing.output) / 1_000_000;
  const cacheReadCost = (cacheReadTokens * pricing.cacheRead) / 1_000_000;
  const cacheWriteCost = (cacheCreateTokens * pricing.cacheWrite) / 1_000_000;
  // Convert dollars to cents
  return (inputCost + outputCost + cacheReadCost + cacheWriteCost) * 100;
}

function recordCall(
  model: string,
  caller: string,
  emailId: string | null,
  accountId: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
  durationMs: number,
  success: boolean,
  errorMessage: string | null,
): void {
  if (!_insertStmt) {
    log.warn("AnthropicService: database not initialized, skipping call recording");
    return;
  }

  const costCents = calculateCostCents(
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
  );

  try {
    _insertStmt.run(
      randomUUID(),
      model,
      caller,
      emailId,
      accountId,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      costCents,
      durationMs,
      success ? 1 : 0,
      errorMessage,
    );
  } catch (err) {
    // Recording failure must never break the LLM call
    log.error({ err }, "Failed to record LLM call to database");
  }
}

/**
 * Record a streaming call's cost after it completes.
 * Use this for calls that bypass createMessage() (e.g., anthropic.messages.stream()).
 */
export function recordStreamingCall(
  model: string,
  caller: string,
  usage: Record<string, number>,
  durationMs: number,
  options?: { emailId?: string; accountId?: string },
): void {
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;
  const cacheCreateTokens = usage.cache_creation_input_tokens || 0;
  recordCall(
    model,
    caller,
    options?.emailId || null,
    options?.accountId || null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    durationMs,
    true,
    null,
  );
}

function asyncSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryCategory(error: unknown): string | null {
  if (error instanceof Anthropic.RateLimitError) return "rate_limit";
  if (error instanceof Anthropic.InternalServerError) return "server_error";
  if (error instanceof Anthropic.APIConnectionError) return "connection";
  // Check for 529 overloaded (comes as APIError with status 529)
  if (error instanceof Anthropic.APIError && (error as { status?: number }).status === 529) {
    return "server_error";
  }
  if (error instanceof OpenAICompatibleError) {
    if (error.status === 429) return "rate_limit";
    if (typeof error.status === "number" && error.status >= 500) return "server_error";
    return null;
  }
  if (error instanceof TypeError) {
    // fetch() network errors are often surfaced as TypeError
    return "connection";
  }
  return null;
}

/**
 * Create a message using Claude API with retry and cost tracking.
 */
export async function createMessage(
  params: MessageCreateParamsNonStreaming,
  options: CreateOptions,
): Promise<Message> {
  const { caller, emailId, accountId, timeoutMs } = options;
  const model = params.model;
  const startTime = Date.now();
  let lastError: unknown = null;
  let totalAttempts = 0;

  // Determine max retries across all categories
  const maxPossibleRetries = Math.max(...Object.values(RETRY_CONFIGS).map((c) => c.maxRetries));

  for (let attempt = 0; attempt <= maxPossibleRetries; attempt++) {
    totalAttempts = attempt + 1;

    // Per-attempt timeout so retries get fresh abort controllers
    let abortController: AbortController | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      abortController = new AbortController();
      timeoutHandle = setTimeout(() => abortController!.abort(), timeoutMs);
    }

    try {
      const response = shouldUseOpenAICompatibleBackend()
        ? await createMessageViaOpenAICompatible(params, {
            ...options,
            timeoutMs,
          }, abortController?.signal)
        : await getClient().messages.create(params, {
            signal: abortController?.signal,
          });

      // Success — record and return
      const usage = response.usage as unknown as Record<string, number>;
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const cacheReadTokens = usage.cache_read_input_tokens || 0;
      const cacheCreateTokens = usage.cache_creation_input_tokens || 0;

      recordCall(
        model,
        caller,
        emailId || null,
        accountId || null,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreateTokens,
        Date.now() - startTime,
        true,
        null,
      );

      if (totalAttempts > 1) {
        log.info({ caller, model, attempts: totalAttempts }, "LLM call succeeded after retries");
      }

      return response;
    } catch (error) {
      lastError = error;
      const category = getRetryCategory(error);

      if (!category) {
        // Non-retryable error — fail immediately
        break;
      }

      const config = RETRY_CONFIGS[category];
      if (attempt >= config.maxRetries) {
        // Exhausted retries for this category
        break;
      }

      // Calculate delay with exponential backoff + jitter
      const baseDelay = Math.min(config.initialDelayMs * Math.pow(2, attempt), config.maxDelayMs);
      const jitter = baseDelay * 0.1 * Math.random();
      const delay = baseDelay + jitter;

      log.warn(
        {
          caller,
          model,
          attempt: attempt + 1,
          maxRetries: config.maxRetries,
          category,
          delayMs: Math.round(delay),
        },
        "LLM call failed, retrying",
      );

      // Non-blocking sleep
      await asyncSleep(delay);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  // All retries exhausted — record failure and throw
  const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
  recordCall(
    model,
    caller,
    emailId || null,
    accountId || null,
    0,
    0,
    0,
    0,
    Date.now() - startTime,
    false,
    errMsg,
  );

  throw lastError;
}

/**
 * Get usage statistics for cost visibility.
 */
export function getUsageStats(): UsageStats {
  if (!_db) {
    return {
      today: { totalCostCents: 0, totalCalls: 0 },
      thisWeek: { totalCostCents: 0, totalCalls: 0 },
      thisMonth: { totalCostCents: 0, totalCalls: 0 },
      byModel: [],
      byCaller: [],
    };
  }

  const today = _db
    .prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM llm_calls WHERE date(created_at) = date('now')",
    )
    .get() as { cost: number; calls: number };

  const thisWeek = _db
    .prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-7 days')",
    )
    .get() as { cost: number; calls: number };

  const thisMonth = _db
    .prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-30 days')",
    )
    .get() as { cost: number; calls: number };

  const byModel = _db
    .prepare(
      "SELECT model, COALESCE(SUM(cost_cents), 0) as costCents, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-30 days') GROUP BY model ORDER BY costCents DESC",
    )
    .all() as Array<{ model: string; costCents: number; calls: number }>;

  const byCaller = _db
    .prepare(
      "SELECT caller, COALESCE(SUM(cost_cents), 0) as costCents, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-30 days') GROUP BY caller ORDER BY costCents DESC",
    )
    .all() as Array<{ caller: string; costCents: number; calls: number }>;

  return {
    today: { totalCostCents: today.cost, totalCalls: today.calls },
    thisWeek: { totalCostCents: thisWeek.cost, totalCalls: thisWeek.calls },
    thisMonth: { totalCostCents: thisMonth.cost, totalCalls: thisMonth.calls },
    byModel,
    byCaller,
  };
}

/**
 * Get recent call history for debugging.
 */
export function getCallHistory(limit: number = 50): LlmCallRecord[] {
  if (!_db) return [];

  return _db
    .prepare("SELECT * FROM llm_calls ORDER BY created_at DESC LIMIT ?")
    .all(limit) as LlmCallRecord[];
}
