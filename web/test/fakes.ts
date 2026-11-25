// A scripted stand-in for the Anthropic client, like tests/fakes.py. No network, no key.
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { MessagesClient } from "../src/client.ts";

type Block = Record<string, unknown>;

export const text = (value: string): Block => ({ type: "text", text: value });

export const toolUse = (name: string, input: unknown, id?: string): Block => ({
  type: "tool_use",
  id: id ?? `toolu_${name}`,
  name,
  input,
});

export const thinking = (value = ""): Block => ({
  type: "thinking",
  thinking: value,
  signature: "sig-fake",
});

export function message(
  content: Block[],
  stopReason: string | null,
  options: {
    model?: string;
    usage?: Record<string, number>;
    stop_details?: Record<string, unknown> | null;
  } = {},
): BetaMessage {
  const msg = {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: options.model ?? "claude-sonnet-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: options.stop_details ?? null,
    usage: options.usage ?? { input_tokens: 1000, output_tokens: 100 },
  };
  // The SDK puts the request id on a non-enumerable property; so does the fake.
  Object.defineProperty(msg, "_request_id", { value: "req_fake", enumerable: false });
  return msg as unknown as BetaMessage;
}

export class FakeClient implements MessagesClient {
  readonly script: (BetaMessage | Error)[];
  readonly requests: MessageCreateParamsNonStreaming[] = [];
  readonly beta: MessagesClient["beta"];

  constructor(script: (BetaMessage | Error)[]) {
    this.script = [...script];
    this.beta = {
      messages: {
        create: async (params) => {
          // Snapshot the request: the agent keeps appending to the same messages list.
          this.requests.push(structuredClone(params));
          const item = this.script.shift();
          if (item === undefined) throw new Error("FakeClient ran out of scripted responses");
          if (item instanceof Error) throw item;
          return item;
        },
      },
    };
  }
}
