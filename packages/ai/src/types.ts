/**
 * Provider-neutral turn shapes. Every provider client streams text deltas,
 * returns a stop reason, and reports usage and assembled tool calls through
 * handlers, translating to and from its own wire format.
 */

/** The image formats the media store accepts. */
export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

/** The image format for a stored media MIME, or null. */
export function imageFormatFor(mime: string): ImageFormat | null {
  switch (mime.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpeg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}

/** One content block of a turn. `image.source.bytes` is base64. */
export type ContentBlock =
  | { text: string }
  | { image: { format: ImageFormat; source: { bytes: string } } }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | { toolResult: { toolUseId: string; content: Array<{ text: string }>; status?: "success" | "error" } };

export interface TurnMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/** One tool the model may call. `inputSchema.json` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { json: Record<string, unknown> };
}

/** A tool call the model made, with its streamed input assembled. */
export interface ToolUse {
  toolUseId: string;
  name: string;
  input: unknown;
}

/** Token usage for one model call; providers without a prompt cache report zero cache tokens. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
};

/** Why a model call ended; provider vocabularies are translated, unknown values passed through. */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | (string & {});

export interface TurnRequest {
  /** Client-facing model id; `streamTurn` maps it to the provider's name. */
  modelId: string;
  system?: string;
  /**
   * A byte-stable prefix marked cacheable on providers with an explicit prompt
   * cache, folded into the system prompt elsewhere. A cache write costs more than
   * a read, so set it only for a prefix that repeats.
   */
  cachedPrefix?: string;
  messages: TurnMessage[];
  maxTokens?: number;
  /** Aborts the request in flight and every retry; the generator throws the abort reason. */
  signal?: AbortSignal;
  /** Tools the model may call; calls arrive through `onToolUse`. */
  tools?: ToolSpec[];
}

export interface TurnHandlers {
  /** Once per call, after the provider reported usage. */
  onUsage?: (usage: TokenUsage) => void;
  /** Once per tool call, after its input is complete. */
  onToolUse?: (tool: ToolUse) => void;
}

/** A bare function is the usage callback. */
export type TurnHandlersArg = TurnHandlers | ((usage: TokenUsage) => void);

export function normalizeHandlers(h: TurnHandlersArg | undefined): TurnHandlers {
  return typeof h === "function" ? { onUsage: h } : (h ?? {});
}

/** Output budget when a request names none. */
export const DEFAULT_MAX_TOKENS = 2048;
