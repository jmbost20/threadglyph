import { SYSTEM_PROMPT, buildPromptText } from './prompt';
import type { AiAdapter, AiErrorKind, AiRequest, AiResult } from './types';

/**
 * Asks the locally installed Claude Code CLI, using the owner's existing
 * sign-in. No API key or new billing is involved.
 *
 * Isolation: every built-in tool is disabled (`--tools ""`), MCP servers and
 * user/project settings are skipped, the working directory is a temp folder
 * outside the vault, and sessions are not saved. The model can only read the
 * request it is given and write text back.
 */

export interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Spawn failure, e.g. ENOENT when the binary does not exist. */
  error?: { code?: string; message: string };
  timedOut: boolean;
  aborted: boolean;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  input: string,
  options: { cwd: string; timeoutMs: number; signal: AbortSignal; env?: Record<string, string> },
) => Promise<RunOutcome>;

export interface ClaudeCliOptions {
  /** Absolute path of the `claude` binary. */
  command: string;
  cwd: string;
  timeoutMs: number;
  /** Empty for the CLI's default model. */
  model: string;
  /** Extra environment, e.g. a PATH that includes the usual install folders. */
  env?: Record<string, string>;
  run: ProcessRunner;
}

export function claudeArgs(model: string, systemPrompt = SYSTEM_PROMPT): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--system-prompt', systemPrompt,
  ];
  if (model.trim()) args.push('--model', model.trim());
  return args;
}

/** One stream-json user message: the image bytes (if any) followed by the text. */
export function claudeInput(request: AiRequest): string {
  const content: unknown[] = [];
  if (request.image) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: request.image.mediaType, data: request.image.data },
    });
  }
  content.push({ type: 'text', text: buildPromptText(request) });
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

const AUTH = /not logged in|log ?in|login|authenticat|api key|unauthori[sz]ed|\b401\b/i;
const QUOTA = /rate.?limit|usage limit|quota|overloaded|out of credits|\b429\b|\b529\b/i;
const NETWORK = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network|socket hang up|offline/i;

export function classifyFailure(text: string): { kind: AiErrorKind; message: string } {
  const detail = text.trim().replace(/\s+/g, ' ').slice(0, 300) || 'no details';
  if (AUTH.test(text)) {
    return { kind: 'auth', message: 'Claude Code is not signed in. Run `claude` in a terminal, sign in, then try again.' };
  }
  if (QUOTA.test(text)) return { kind: 'quota', message: `Claude is at a usage or rate limit. Try again later. (${detail})` };
  if (NETWORK.test(text)) return { kind: 'network', message: `Claude could not be reached. Check your connection. (${detail})` };
  return { kind: 'failed', message: `Claude Code failed: ${detail}` };
}

interface ResultLine {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
}

function findResult(stdout: string): ResultLine | null {
  let found: ResultLine | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string };
      if (parsed.type === 'result') found = parsed as ResultLine;
    } catch {
      // Non-JSON noise on stdout is ignored; only the result line matters.
    }
  }
  return found;
}

export class ClaudeCliAdapter implements AiAdapter {
  readonly id = 'claude';
  readonly name = 'Claude';
  readonly egress = 'cloud' as const;
  readonly capabilities = { text: true, images: true } as const;

  constructor(private readonly options: ClaudeCliOptions) {}

  get detail(): string {
    return this.options.model.trim() || 'Claude Code';
  }

  async ask(request: AiRequest, signal: AbortSignal): Promise<AiResult> {
    const { command, cwd, model, env, run } = this.options;
    const timeoutMs = this.options.timeoutMs;
    if (signal.aborted) return { ok: false, kind: 'cancelled', message: 'Cancelled.' };
    const out = await run(command, claudeArgs(model), claudeInput(request), { cwd, timeoutMs, signal, env });
    if (out.aborted) return { ok: false, kind: 'cancelled', message: 'Cancelled.' };
    if (out.timedOut) {
      return { ok: false, kind: 'timeout', message: `Claude did not answer within ${Math.round(timeoutMs / 1000)} seconds.` };
    }
    if (out.error) {
      if (out.error.code === 'ENOENT') {
        return {
          ok: false,
          kind: 'not-installed',
          message: `Claude Code was not found at ${command}. Install it, or set its path in Threadglyph settings.`,
        };
      }
      return { ok: false, ...classifyFailure(out.error.message) };
    }
    const result = findResult(out.stdout);
    if (result && !result.is_error && result.subtype === 'success' && result.result?.trim()) {
      return { ok: true, text: result.result.trim() };
    }
    if (result && !result.is_error && result.subtype === 'success') {
      return { ok: false, kind: 'failed', message: 'Claude returned an empty reply.' };
    }
    return { ok: false, ...classifyFailure(`${result?.result ?? ''}\n${out.stderr}`) };
  }
}

/** Common install locations; Obsidian started from the Dock does not inherit the shell PATH. */
export function claudeCandidates(home: string): string[] {
  return [
    `${home}/.local/bin/claude`,
    `${home}/.claude/local/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
}
