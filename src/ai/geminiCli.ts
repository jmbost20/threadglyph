import type { ProcessRunner } from './claudeCli';
import lockdown from './cli-lockdown.json';
import { SYSTEM_PROMPT, buildPromptText } from './prompt';
import type { AiAdapter, AiErrorKind, AiRequest, AiResult } from './types';

/**
 * Asks Google's Gemini through the locally installed Gemini CLI, using the
 * owner's own Gemini API key. Verified against Gemini CLI 0.60.
 *
 * Isolation: every request runs in a new private home folder that holds only
 * Threadglyph's settings and a link to the key file, and is deleted afterwards. So the
 * user's `~/.gemini` (settings, hooks, GEMINI.md, extensions, MCP servers) and the key
 * folder's own settings are never read, and nothing runs in the vault. The CLI runs in
 * read-only `plan` mode with extensions, MCP servers, hooks, skills, context files,
 * telemetry and every built-in tool off, and endpoint overrides cleared, so the request
 * goes to Google. An administrator's system settings still apply. The request text goes in on stdin, so note text
 * never appears in the process list. An image is copied to a private temporary
 * folder for the one request and deleted afterwards.
 *
 * Egress is cloud: the request is sent to Google.
 */

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
/** Offered when the default model is overloaded; it is usually still answering. */
export const LIGHT_GEMINI_MODEL = 'gemini-3.1-flash-lite';

/** Every built-in tool in Gemini CLI 0.60. Answering a comment needs none of them. */
export const GEMINI_TOOLS: string[] = lockdown.gemini.settings.tools.exclude;

/**
 * The settings of every Gemini run, in a home folder made for that run: API-key sign-in,
 * the working folder trusted (so its `.env` is read and plan mode holds), and hooks, skills,
 * context files, telemetry, usage statistics and every built-in tool switched off.
 */
export const GEMINI_LOCKDOWN_SETTINGS: Record<string, unknown> = lockdown.gemini.settings;

/**
 * The environment for one Gemini run in `home`. Values set here win over the key file,
 * which only fills in variables that are not set.
 */
export function geminiEnv(home: string): Record<string, string> {
  return { ...lockdown.gemini.env, GEMINI_CLI_HOME: home };
}

export interface GeminiFiles {
  /** Creates the folder and its parents if they do not exist. */
  ensureDir(dir: string): Promise<void>;
  /**
   * The key file Gemini would find for `folder`: its `.gemini/.env`, else its `.env`, else
   * `~/.gemini/.env`; null when there is none.
   */
  findKeyFile(folder: string): Promise<string | null>;
  /**
   * Makes a private temporary Gemini home for one run: `.gemini/settings.json` holding
   * `settings`, and `.gemini/.env` pointing at `keyFile` when there is one. Returns its path.
   */
  makeRunHome(settings: string, keyFile: string | null): Promise<string>;
  /** Writes the image into a new private temporary folder and returns that folder and the file's path. */
  stageImage(bytes: Uint8Array, extension: string): Promise<{ dir: string; file: string }>;
  removeDir(dir: string): Promise<void>;
}

export interface GeminiCliOptions {
  command: string;
  /** The folder holding the key, in `.gemini/.env` (or `.env`). */
  folder: string;
  /**
   * True for Threadglyph's own folder, whose `.gemini` folder is created so the key has
   * somewhere to go. A folder the owner points at (e.g. another tool's) is never written to.
   */
  ownsFolder: boolean;
  /** True when GEMINI_API_KEY is already set in the environment Obsidian passes on. */
  keyInEnvironment?: boolean;
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
export const NO_MCP_SERVERS = lockdown.gemini.args[1];

export function geminiArgs(model: string, image: string | null, imageDir: string | null): string[] {
  const args = ['-p', image ? `Attached image: @${image}` : 'Write your reply now.'];
  if (imageDir) args.push('--include-directories', imageDir);
  args.push(...lockdown.gemini.args, '-m', model.trim() || DEFAULT_GEMINI_MODEL);
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
    if (ownsFolder) await files.ensureDir(`${folder}/.gemini`);
    const keyFile = await files.findKeyFile(folder);
    if (!keyFile && !this.options.keyInEnvironment) {
      return { ok: false, kind: 'auth', message: `Gemini is not set up. Put your key in ${folder}/.gemini/.env as GEMINI_API_KEY=…, then try again.` };
    }
    const home = await files.makeRunHome(`${JSON.stringify(GEMINI_LOCKDOWN_SETTINGS, null, 2)}\n`, keyFile);
    let staged: { dir: string; file: string } | null = null;
    try {
      if (request.image) {
        staged = await files.stageImage(Uint8Array.from(atob(request.image.data), (c) => c.codePointAt(0)!), EXTENSIONS[request.image.mediaType]);
      }
      const args = geminiArgs(model, staged?.file ?? null, staged?.dir ?? null);
      const out = await run(command, args, geminiInput(request), { cwd: home, timeoutMs, signal, env: { ...env, ...geminiEnv(home) } });
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
      // Gemini's own logs of this run (chats, history) go with it.
      await files.removeDir(home);
    }
  }
}
