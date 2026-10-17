import { isAbsolute, resolve } from 'node:path';

/** Which agent sent the hook: their stdin and stdout JSON differ. */
export type HookDialect = 'claude' | 'cursor';

export interface HookInput {
  dialect: HookDialect;
  /** `PostToolUse`, `Stop`, `SessionStart`; Cursor: `postToolUse`, `afterFileEdit`, `stop`, `sessionStart`. */
  event?: string;
  /** Claude Code `session_id`, Cursor `conversation_id`. */
  sessionId?: string;
  /** Where the agent runs (the project). */
  cwd: string;
  /** Absolute paths of the files the tool wrote. */
  files: string[];
  toolName?: string;
  /**
   * The agent is already continuing because a stop hook asked it to (Claude Code
   * `stop_hook_active`, Cursor `loop_count > 0`): a stop hook must not ask again.
   */
  stopHookActive: boolean;
}

type Json = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Read the JSON a coding agent pipes to a hook: Claude Code's hook input (`PostToolUse`
 * with `tool_input.file_path` or `notebook_path`, `Stop` with `stop_hook_active`) or
 * Cursor's (`afterFileEdit`/`postToolUse` with `file_path`, `stop` with `loop_count`).
 * Empty or invalid input reads as an event with no files, in the current directory.
 */
export function parseHookInput(text: string, env: NodeJS.ProcessEnv = process.env, dialect?: HookDialect): HookInput {
  let doc: Json = {};
  try {
    const parsed = JSON.parse(text || '{}') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed as Json;
  } catch {
    // Not JSON: nothing to act on.
  }
  const roots = Array.isArray(doc.workspace_roots) ? (doc.workspace_roots as unknown[]).map(str).filter((x): x is string => !!x) : [];
  // Cursor names the conversation and the workspace roots; Claude Code names the session.
  const which: HookDialect = dialect ?? ('conversation_id' in doc || 'workspace_roots' in doc || 'cursor_version' in doc || 'loop_count' in doc ? 'cursor' : 'claude');
  const cwd = str(doc.cwd) ?? (which === 'claude' ? str(env.CLAUDE_PROJECT_DIR) : undefined) ?? roots[0] ?? env.CURSOR_PROJECT_DIR ?? process.cwd();

  const input = (typeof doc.tool_input === 'object' && doc.tool_input) || {};
  const response = (typeof doc.tool_response === 'object' && doc.tool_response) || {};
  const ti = input as Json;
  const tr = response as Json;
  const raw = [str(ti.file_path), str(ti.notebook_path), str(ti.path), str(ti.target_file), str(tr.filePath), str(doc.file_path)].filter((x): x is string => !!x);
  const files = [...new Set(raw.map((p) => (isAbsolute(p) ? p : resolve(cwd, p))))];

  const loops = typeof doc.loop_count === 'number' ? doc.loop_count : 0;
  return {
    dialect: which,
    event: str(doc.hook_event_name),
    sessionId: str(doc.session_id) ?? str(doc.conversation_id),
    cwd,
    files,
    toolName: str(doc.tool_name),
    stopHookActive: doc.stop_hook_active === true || loops > 0,
  };
}
