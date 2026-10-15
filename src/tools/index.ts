import { z } from 'zod';
import type { ModelTool } from '../agent/model.js';
import { clearanceTool, impactTool, rankSectionsTool, readSectionTool } from './graph-tools.js';
import { decisionsForTool, proposeEditTool, recordVerdictTool, writeDecisionTool } from './memory-tools.js';
import { runExampleTool } from './run-example.js';
import type { ToolDef } from './types.js';

/** The tools the agent chooses between on every check. */
export const AGENT_TOOLS: ToolDef[] = [
  impactTool,
  clearanceTool,
  readSectionTool,
  runExampleTool,
  decisionsForTool,
  rankSectionsTool,
  proposeEditTool,
  recordVerdictTool,
];

/** Everything MCP clients get: the agent tools plus the human-driven ones. */
export const ALL_TOOLS: ToolDef[] = [...AGENT_TOOLS, writeDecisionTool];

export function toolByName(name: string, tools: ToolDef[] = ALL_TOOLS): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}

/** JSON Schema for a tool's input (what the model and MCP clients see). */
export function inputJsonSchema(tool: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input as z.ZodType, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function modelTools(tools: ToolDef[] = AGENT_TOOLS): ModelTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: inputJsonSchema(t) as ModelTool['input_schema'],
  }));
}
