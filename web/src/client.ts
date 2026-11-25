/**
 * The one place the Claude API is called. Port of `helpdesk_agent/client.py`.
 *
 * - The client is passed in (`node/anthropic.ts` builds the real one): `maxRetries` 2,
 *   `timeout` 60 seconds.
 * - Model IDs and prices are constants here, nowhere else.
 * - `max_tokens` is always set.
 * - Every call, success or failure, writes one entry to the call log: ticket, model,
 *   request ID, tokens, cost, latency, stop reason. Never the prompt, the response text or
 *   anything from the environment.
 *
 * The API key is read by the SDK from the environment, which only `op run` sets. This
 * module never reads, passes or logs it.
 */
import type {
  BetaMessage,
  BetaMessageParam,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { ApiToolDefinition } from "./tools.ts";

export const AGENT_MODEL = "claude-sonnet-5-5";
export const GRADER_MODEL = "claude-haiku-5-5";

export const MAX_RETRIES = 2;
export const TIMEOUT_SECONDS = 60;
export const MAX_TOKENS = 16_000;
// Sonnet 5.5 recommends starting multistep tool use at medium effort.
export const EFFORT = "medium";

// Server-side refusal fallback: if the model declines, the API re-runs the request on a
// fallback model it picks by refusal category, inside the same call.
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const FALLBACKS = "default";

/** US dollars per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheWrite: number; // 5-minute cache writes: 1.25x input
  cacheRead: number;
  // Above this many prompt tokens, the long-context rates apply (Haiku 5.5 only).
  longContextThreshold?: number;
  longInput?: number;
  longOutput?: number;
}

// Checked against the published price list on 2026-11-13 (same as client.py). Re-check
// before quoting costs in the write-up.
export const PRICES: Readonly<Record<string, Price>> = {
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.1 },
  // Possible refusal-fallback target for Sonnet 5.5.
  "claude-sonnet-5": { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheWrite: 0.125,
    cacheRead: 0.01,
    longContextThreshold: 100_000,
    longInput: 0.5,
    longOutput: 2.5,
  },
};

export type Usage = Partial<
  Record<
    "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens",
    unknown
  >
>;

/** Python's `_get`: the field if it is an integer, else 0. */
function tokens(usage: Usage | null | undefined, name: keyof Usage): number {
  const value = usage?.[name];
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

/** Cost of one response in US dollars, or null if the model isn't in `PRICES`. */
export function costUsd(model: string, usage: Usage | null | undefined): number | null {
  const price = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  if (price === undefined || usage === null || usage === undefined) return null;
  const fresh = tokens(usage, "input_tokens");
  const written = tokens(usage, "cache_creation_input_tokens");
  const read = tokens(usage, "cache_read_input_tokens");
  const out = tokens(usage, "output_tokens");
  let inputRate = price.input;
  let outputRate = price.output;
  let writtenRate = price.cacheWrite;
  let readRate = price.cacheRead;
  if (
    price.longContextThreshold !== undefined &&
    fresh + written + read > price.longContextThreshold
  ) {
    const longInput = price.longInput as number;
    const scale = longInput / price.input;
    inputRate = longInput;
    outputRate = price.longOutput as number;
    writtenRate = price.cacheWrite * scale;
    readRate = price.cacheRead * scale;
  }
  const total =
    (fresh * inputRate + written * writtenRate + read * readRate + out * outputRate) / 1_000_000;
  return Number(total.toFixed(6)); // Python round(total, 6): same value for finite doubles
}

/** What we need from the SDK client. Tests pass a scripted fake instead. */
export interface MessagesClient {
  beta: {
    messages: {
      create(params: MessageCreateParamsNonStreaming): PromiseLike<BetaMessage>;
    };
  };
}

/** Where call-log entries go: a JSON-lines file in Node, storage in a Worker. */
export interface CallLog {
  write(entry: Record<string, unknown>): Promise<void>;
}

/** Keeps entries in memory (tests, and eval runs that sum costs). */
export class MemoryCallLog implements CallLog {
  readonly entries: Record<string, unknown>[] = [];
  async write(entry: Record<string, unknown>): Promise<void> {
    this.entries.push(entry);
  }
}

export interface RequestInput {
  system: string;
  messages: BetaMessageParam[];
  tools?: ApiToolDefinition[];
  outputFormat?: Record<string, unknown>;
}

export interface ModelCallerOptions {
  model?: string;
  maxTokens?: number;
  effort?: string | null;
  fallbacks?: boolean;
  /** Milliseconds, for latency. Injected so tests are deterministic. */
  now?: () => number;
}

/** Makes Messages API calls with our fixed settings and logs each one. */
export class ModelCaller {
  readonly client: MessagesClient | null;
  readonly log: CallLog;
  readonly model: string;
  readonly maxTokens: number;
  readonly effort: string | null;
  readonly fallbacks: boolean;
  private readonly now: () => number;

  constructor(client: MessagesClient | null, log: CallLog, options: ModelCallerOptions = {}) {
    this.client = client;
    this.log = log;
    this.model = options.model ?? AGENT_MODEL;
    this.maxTokens = options.maxTokens ?? MAX_TOKENS;
    this.effort = options.effort === undefined ? EFFORT : options.effort;
    this.fallbacks = options.fallbacks ?? true;
    this.now = options.now ?? (() => performance.now());
  }

  /** The exact request body, in the same key order as Python's (the cache is a prefix). */
  requestParams({
    system,
    messages,
    tools,
    outputFormat,
  }: RequestInput): MessageCreateParamsNonStreaming {
    const params: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages,
      // Caches tools + system + history up to the last block: the prefix is stable because
      // the tool list is sorted and the system prompt has no timestamps.
      cache_control: { type: "ephemeral" },
    };
    if (tools && tools.length > 0) params.tools = tools;
    const outputConfig: Record<string, unknown> = {};
    if (this.effort !== null) outputConfig.effort = this.effort;
    if (outputFormat !== undefined) outputConfig.format = outputFormat;
    if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig;
    if (this.fallbacks) {
      params.betas = [FALLBACK_BETA];
      params.fallbacks = FALLBACKS;
    }
    return params as unknown as MessageCreateParamsNonStreaming;
  }

  /** Send one request and log it. Re-throws API errors after logging them. */
  async create(ticketId: string, purpose: string, request: RequestInput): Promise<BetaMessage> {
    if (this.client === null) throw new Error("no client: this caller only builds requests");
    const params = this.requestParams(request);
    const started = this.now();
    let response: BetaMessage;
    try {
      response = await this.client.beta.messages.create(params);
    } catch (exc) {
      const err = exc as { name?: unknown; status?: unknown; requestID?: unknown };
      await this.log.write({
        event: "model_call",
        ticket_id: ticketId,
        purpose,
        model_requested: this.model,
        latency_ms: Math.round(this.now() - started),
        error: exc instanceof Error ? exc.name : typeof exc,
        status_code: typeof err?.status === "number" ? err.status : null,
        request_id: typeof err?.requestID === "string" ? err.requestID : null,
      });
      throw exc;
    }
    const latencyMs = Math.round(this.now() - started);
    const usage = (response.usage ?? null) as Usage | null;
    const servedBy = response.model || this.model;
    const stopDetails = (response as { stop_details?: { category?: unknown } | null }).stop_details;
    const requestId = (response as { _request_id?: unknown })._request_id;
    await this.log.write({
      event: "model_call",
      ticket_id: ticketId,
      purpose,
      model_requested: this.model,
      model: servedBy,
      request_id: typeof requestId === "string" ? requestId : null,
      input_tokens: tokens(usage, "input_tokens"),
      output_tokens: tokens(usage, "output_tokens"),
      cache_creation_input_tokens: tokens(usage, "cache_creation_input_tokens"),
      cache_read_input_tokens: tokens(usage, "cache_read_input_tokens"),
      cost_usd: costUsd(servedBy, usage),
      latency_ms: latencyMs,
      stop_reason: response.stop_reason ?? null,
      refusal_category: stopDetails?.category ?? null,
    });
    return response;
  }
}
