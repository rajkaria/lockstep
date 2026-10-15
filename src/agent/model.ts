import type Anthropic from '@anthropic-ai/sdk';

export type ModelMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type ModelMessage = Anthropic.Beta.Messages.BetaMessage;
export type ModelTool = Anthropic.Beta.Messages.BetaTool;
export type ModelToolUse = Anthropic.Beta.Messages.BetaToolUseBlock;
export type ModelToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export interface TurnRequest {
  system: string;
  tools: ModelTool[];
  messages: ModelMessageParam[];
}

export interface TurnCallbacks {
  onText?(delta: string): void;
  onThinking?(delta: string): void;
}

/** One model turn: the request goes in, the complete assistant message comes out. */
export interface ModelClient {
  readonly name: string;
  turn(req: TurnRequest, cb?: TurnCallbacks): Promise<ModelMessage>;
}
