import type { ProcessRunner } from './claudeCli';
import { SYSTEM_PROMPT, buildPromptText } from './prompt';
import type { AiAdapter, AiErrorKind, AiRequest, AiResult } from './types';

/**
 * Asks Google's Gemini through the locally installed Gemini CLI, using the
 * owner's own Gemini API key. Verified against Gemini CLI 0.60.
 *
 * Isolation: the CLI runs in Threadglyph's own folder (never the vault), in
 * read-only `plan` mode with extensions off, no MCP servers, and every
 * built-in tool excluded by that folder's settings. The request text goes in on stdin, so note text
 * never appears in the process list. An image is copied to a private temporary
 * folder for the one request and deleted afterwards.
 *
 * Egress is cloud: the request is sent to Google.
 */

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
/** Offered when the default model is overloaded; it is usually still answering. */
export const LIGHT_GEMINI_MODEL = 'gemini-3.1-flash-lite';

/** Every built-in tool in Gemini CLI 0.60. Answering a comment needs none of them. */
export const GEMINI_TOOLS = [
  'activate_skill', 'ask_user', 'complete_task', 'enter_plan_mode', 'exit_plan_mode', 'get_internal_docs', 'glob',
  'google_web_search', 'grep_search', 'invoke_agent', 'list_directory', 'list_mcp_resources', 'read_file',
  'read_many_files', 'read_mcp_resource', 'replace', 'run_shell_command', 'take_snapshot', 'update_topic', 'web_fetch',
  'write_file', 'write_todos', 'list_background_processes', 'read_background_output',
];

/** Written once into the Gemini folder; an existing file is never overwritten. */
export const GEMINI_FOLDER_SETTINGS = {
  security: { auth: { selectedType: 'gemini-api-key' } },
  privacy: { usageStatisticsEnabled: false },
  tools: { exclude: GEMINI_TOOLS },
};

export interface GeminiFiles {
  /** Creates `<folder>/.gemini/settings.json` if it does not exist. */
  prepareFolder(folder: string, settings: string): Promise<void>;
  /** Writes the image into a new private temporary folder and returns that folder and the file's path. */
  stageImage(bytes: Uint8Array, extension: string): Promise<{ dir: string; file: string }>;
  removeDir(dir: string): Promise<void>;
}

export interface GeminiCliOptions {
  command: string;
  /** The working directory, holding `.gemini/settings.json` and `.gemini/.env`. */
  folder: string;
  /**
   * True for Threadglyph's own folder, which gets tool-free settings on first use.
   * A folder the owner points at (e.g. another tool's) is borrowed and never written to.
   */
  ownsFolder: boolean;
  model: string;
  timeoutMs: number;
  env: Record<string, string>;
  run: ProcessRunner;
  files: GeminiFiles;
}

/**
 * Gemini CLI starts every MCP server in the user's own settings unless an
 * allow-list names the ones to keep, and it reads an empty list as "all". So
 * the list names one server that cannot exist, and none is started.
 */
export const NO_MCP_SERVERS = 'threadglyph-no-mcp-servers';

export function geminiArgs(model: string, image: string | null, imageDir: string | null): string[] {
  const args = ['-p', image ? `Attached image: @${image}` : 'Write your reply now.'];
  if (imageDir) args.push('--include-directories', imageDir);
  args.push('--allowed-mcp-server-names', NO_MCP_SERVERS, '-e', 'none', '--output-format', 'json', '--approval-mode', 'plan', '-m', model.trim() || DEFAULT_GEMINI_MODEL);
  return args;
}

/** The request as sent on stdin: standing instructions, then the fenced note material and thread. */
export function geminiInput(request: AiRequest): string {
  return `${SYSTEM_PROMPT}\n\n---\n\n${buildPromptText(request)}\n`;
}

/** The reply text from `--output-format json`, or null when the output has no answer. */
export function geminiResponse(stdout: string): string | null {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as { response?: unknown };
    return typeof parsed.response === 'string' && parsed.response.trim() ? parsed.response.trim() : null;
  } catch {
    return null;
  }
}

const BUSY = /\b503\b|UNAVAILABLE|high demand|overloaded/i;
const QUOTA = /RESOURCE_EXHAUSTED|TerminalQuotaError|quota|\b429\b|rate.?limit/i;
const INELIGIBLE = /IneligibleTier|UNSUPPORTED_CLIENT|no longer supported/i;
const AUTH = /"code":\s*41\b|auth\w*|api[_ ]?key|credential|login|sign[- ]?in|PERMISSION_DENIED|\b401\b|\b403\b/i;
const OLD_NODE = /does not provide an export named|SyntaxError: Unexpected/i;
const NETWORK = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed/i;

export function classifyGeminiFailure(
  text: string,
  folder: string,
  timedOut: boolean,
  timeoutMs: number,
): { kind: AiErrorKind; message: string } {
  // Stack frames ("    at fn (file:1:2)") add length, not meaning.
  const lines = text.split('\n').filter((line) => !line.trimStart().startsWith('at '));
  const detail = lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300) || 'no details';
  if (BUSY.test(text)) {
    return {
      kind: 'busy',
      message:
        `Gemini is overloaded right now (HTTP 503)${timedOut ? ' and was still retrying when the time ran out' : ''}. ` +
        `Try again in a few minutes, or set the Gemini model to ${LIGHT_GEMINI_MODEL} in settings.`,
    };
  }
  if (QUOTA.test(text)) {
    return { kind: 'quota', message: `Gemini's quota for this model is used up. Try another model or assistant. (${detail})` };
  }
  if (timedOut) {
    return { kind: 'timeout', message: `Gemini did not answer within ${Math.round(timeoutMs / 1000)} seconds.` };
  }
  if (INELIGIBLE.test(text)) {
    return {
      kind: 'auth',
      message: `Google no longer serves this account through Gemini CLI sign-in. Put GEMINI_API_KEY=… in ${folder}/.gemini/.env.`,
    };
  }
  if (OLD_NODE.test(text)) {
    return { kind: 'failed', message: 'Gemini CLI was started by a Node.js version too old for it. Install Node 20 or newer.' };
  }
  if (AUTH.test(text)) {
    return {
      kind: 'auth',
      message: `Gemini is not set up. Put your key in ${folder}/.gemini/.env as GEMINI_API_KEY=…, then try again.`,
    };
  }
  if (NETWORK.test(text)) return { kind: 'network', message: `Gemini could not be reached. Check your connection. (${detail})` };
  return { kind: 'failed', message: `Gemini CLI failed: ${detail}` };
}

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export class GeminiCliAdapter implements AiAdapter {
  readonly id = 'gemini';
  readonly name = 'Gemini';
  readonly egress = 'cloud' as const;
  readonly capabilities = { text: true, images: true } as const;

  constructor(private readonly options: GeminiCliOptions) {}

  get detail(): string {
    return this.options.model.trim() || DEFAULT_GEMINI_MODEL;
  }

  async ask(request: AiRequest, signal: AbortSignal): Promise<AiResult> {
    const { command, folder, ownsFolder, model, env, run, files } = this.options;
    const timeoutMs = this.options.timeoutMs;
    if (signal.aborted) return { ok: false, kind: 'cancelled', message: 'Cancelled.' };
    if (ownsFolder) await files.prepareFolder(folder, `${JSON.stringify(GEMINI_FOLDER_SETTINGS, null, 2)}\n`);

    let staged: { dir: string; file: string } | null = null;
    try {
      if (request.image) {
        staged = await files.stageImage(Uint8Array.from(atob(request.image.data), (c) => c.codePointAt(0)!), EXTENSIONS[request.image.mediaType]);
      }
      const args = geminiArgs(model, staged?.file ?? null, staged?.dir ?? null);
      const out = await run(command, args, geminiInput(request), { cwd: folder, timeoutMs, signal, env });
      if (out.aborted) return { ok: false, kind: 'cancelled', message: 'Cancelled.' };
      if (out.error?.code === 'ENOENT') {
        return {
          ok: false,
          kind: 'not-installed',
          message: `Gemini CLI was not found at ${command}. Install it (\`npm install -g @google/gemini-cli\`) or set its path in settings.`,
        };
      }
      const text = out.code === 0 ? geminiResponse(out.stdout) : null;
      if (text) return { ok: true, text };
      if (out.code === 0 && !out.timedOut) return { ok: false, kind: 'failed', message: 'Gemini returned an empty reply.' };
      return { ok: false, ...classifyGeminiFailure(`${out.error?.message ?? ''}\n${out.stderr}`, folder, out.timedOut, timeoutMs) };
    } finally {
      if (staged) await files.removeDir(staged.dir);
    }
  }
}
