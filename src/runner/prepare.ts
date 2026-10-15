import { fromRepl } from '../indexer/docs.js';

export interface ExampleSource {
  id: string;
  lang: string;
  code: string;
}

export interface PreparedExample {
  /** The program that will run (earlier fragments from the page prepended when needed). */
  code: string;
  /** Ids of earlier examples stitched in front of this one. */
  stitched: string[];
  /** Why this example cannot be run honestly; set → the run is recorded as skipped. */
  skip?: string;
}

const LLM =
  /\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|AZURE_OPENAI|GROQ_API_KEY|COHERE_API_KEY|MISTRAL_API_KEY)\b|\bmodel\s*=\s*["'](openai|anthropic|gpt-|claude|gemini|azure|groq|ollama|bedrock|vertex|mistral|cohere)|\b(LiteLLM|LiteLLMEmbedder|OpenAI|AsyncOpenAI|Anthropic|ChatOpenAI|OpenAIEmbeddings)\s*\(/i;
const LOCAL_FILE = /["']([^"'\s]+\.(pdf|csv|txt|json|jsonl|docx?|html?|xlsx?|parquet|md))["']/i;
const PLACEHOLDER = /["'][^"']*<(your|YOUR|insert|INSERT)[^>]*>[^"']*["']|["']your[-_][a-z-_]*(key|password|token|host)["']/;
const NEEDS_SERVICE = /\b(requests|httpx|urllib\.request|aiohttp)\b.*\b(get|post)\s*\(|\bboto3\b|\bpsycopg2?\b|\bneo4j\b/;

/** Why an example can't be run as written, or undefined when it can. */
export function skipReason(code: string, lang: string): string | undefined {
  if (lang !== 'python') return `not Python (${lang || 'no language tag'})`;
  if (!code.trim()) return 'empty example';
  const llm = LLM.exec(code);
  if (llm) return `needs an LLM provider (${llm[0].trim().slice(0, 40)}); Lockstep does not hold provider keys`;
  const file = LOCAL_FILE.exec(code);
  if (file && !/\.(write|dump|to_csv|to_json)\b/.test(code)) return `reads a local file the docs do not provide (${file[1]})`;
  if (PLACEHOLDER.test(code)) return 'contains placeholders to fill in (e.g. "<your-host>")';
  if (/\binput\s*\(/.test(code)) return 'waits for user input';
  if (NEEDS_SERVICE.test(code)) return 'calls an external service';
  return undefined;
}

const IMPORT = /^\s*(import|from)\s+\w/m;

/**
 * Make an example runnable the way a reader would run it: a fragment with no
 * imports is preceded by the page's earlier (runnable) Python examples.
 */
export function prepareExample(target: ExampleSource, earlier: ExampleSource[]): PreparedExample {
  const code = fromRepl(target.code);
  const skip = skipReason(code, target.lang);
  if (skip) return { code, stitched: [], skip };
  if (IMPORT.test(code)) return { code, stitched: [] };
  const usable = earlier.filter((e) => e.lang === 'python' && !skipReason(fromRepl(e.code), e.lang));
  if (usable.length === 0) return { code, stitched: [] };
  return {
    code: [...usable.map((e) => `# --- stitched from ${e.id}\n${fromRepl(e.code)}`), `# --- ${target.id}\n${code}`].join('\n\n'),
    stitched: usable.map((e) => e.id),
  };
}

/** The last traceback in stderr. */
export function extractTraceback(stderr: string): string | undefined {
  const i = stderr.lastIndexOf('Traceback (most recent call last):');
  if (i < 0) return undefined;
  return stderr.slice(i).trim();
}

/** `AttributeError: 'Graph' object has no attribute 'x'` — the final line of a traceback. */
export function errorLine(traceback: string | undefined): string | undefined {
  if (!traceback) return undefined;
  const lines = traceback.trim().split('\n');
  return lines[lines.length - 1]?.trim();
}

/** A NameError on a name nothing on the page defines means the example is a fragment, not broken. */
export function isFragmentFailure(code: string, traceback: string | undefined): boolean {
  const m = /NameError: name '(\w+)' is not defined/.exec(traceback ?? '');
  if (!m) return false;
  const name = m[1]!;
  return !new RegExp(`(^|\\n)\\s*(def|class)\\s+${name}\\b|\\b${name}\\s*=|import\\s+.*\\b${name}\\b|as\\s+${name}\\b`).test(code);
}
