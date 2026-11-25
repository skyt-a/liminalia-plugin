/** 接続先の CLI と話す部品（Codex の app-server と agy）が揃える形。 */

export interface RawModel {
  id: string;
  displayName?: string;
  isDefault?: boolean;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: (string | { reasoningEffort?: string })[];
  defaultServiceTier?: string;
  serviceTiers?: (string | { id?: string; name?: string; description?: string })[];
  additionalSpeedTiers?: (string | { id?: string; name?: string; description?: string })[];
}

export interface ThreadParams {
  cwd: string;
  model?: string;
  serviceTier?: string;
  developerInstructions: string;
}

export interface TurnParams {
  threadId: string;
  input: { type: "text"; text: string }[];
  model: string;
  effort: string;
  serviceTier?: string;
  outputSchema?: unknown;
}

export interface TurnOptions {
  timeoutMs: number;
  /** 答えの差分。reset なら、それまでの答えを捨てて新しく始める。 */
  onDelta?(delta: string, reset: boolean): void;
  onProgress?(kind: "reasoning" | "buffering" | "retry"): void;
}

export interface TurnHandle {
  done: Promise<{ text: string }>;
  interrupt(): Promise<unknown>;
}

export interface AiClient {
  ensureStarted(): Promise<void>;
  listModels(): Promise<RawModel[]>;
  /** ログインが要るのにしていなければ needsLogin。 */
  readAccount(): Promise<{ needsLogin: boolean }>;
  startThread(params: ThreadParams): Promise<string>;
  startTurn(params: TurnParams, options: TurnOptions): Promise<TurnHandle>;
  /** CLI が止まったとき。 */
  onExit(listener: () => void): void;
  dispose(): void;
}

/** code 付きの例外（取り消し・時間切れなどを見分ける）。status を付けると、画面にその状態で返る。 */
export class AiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 500,
  ) {
    super(message);
  }
}

export const cancelled = () => new AiError("生成を止めました", "CANCELLED", 409);
