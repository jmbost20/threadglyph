import type { HttpFn } from './http';
import { buildPromptText, systemPromptFor } from './prompt';
import type { AiAdapter, AiRequest, AiResult } from './types';

/**
 * "Local": a model served by Ollama on this computer, over its HTTP API. No
 * account, key or cloud service is involved, and the request never leaves the
 * machine — unless the model is one of Ollama's `:cloud` models, which run on
 * ollama.com and are labelled as cloud accordingly.
 */

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen3:8b';
/** A vision model to suggest when the configured one cannot see images. */
export const SUGGESTED_VISION_MODEL = 'qwen2.5vl:7b';

export interface OllamaOptions {
  host: string;
  model: string;
  timeoutMs: number;
  http: HttpFn;
}

export const isCloudModel = (model: string) => /:cloud$|-cloud$/i.test(model.trim());

/** Reasoning models may still emit a think block inline; it is not part of the reply. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** Ollama's usual context window, in tokens. */
export const OLLAMA_DEFAULT_CONTEXT = 4_096;
const MAX_AGENT_CONTEXT = 32_768;

/**
 * The context an agent request needs: its prompt plus an answer as long as the
 * text it may rewrite (about 3 characters a token), in steps of 4,096 tokens.
 * Ollama otherwise keeps its default window and silently drops the start of a
 * longer prompt, which is where the instructions are. Null leaves the default.
 */
export function agentContextTokens(request: AiRequest, promptChars: number): number | null {
  if (!request.target) return null;
  const needed = Math.ceil((promptChars + request.target.text.length) / 3) + 1_024;
  if (needed <= OLLAMA_DEFAULT_CONTEXT) return null;
  return Math.min(MAX_AGENT_CONTEXT, Math.ceil(needed / OLLAMA_DEFAULT_CONTEXT) * OLLAMA_DEFAULT_CONTEXT);
}

/** The host part of an address, or the address itself when it cannot be parsed. */
function hostName(address: string): string {
  try {
    return new URL(address).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return address;
  }
}

/** True for an address on this computer (localhost, 127.x.x.x, ::1). Anything unparseable counts as remote. */
export function isLoopback(address: string): boolean {
  try {
    new URL(address);
  } catch {
    return false;
  }
  const host = hostName(address).toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export class OllamaAdapter implements AiAdapter {
  readonly id = 'local';
  readonly name = 'Local';
  readonly capabilities = { text: true, images: true } as const;
  private readonly host: string;

  constructor(private readonly options: OllamaOptions) {
    let host = options.host.trim() || DEFAULT_OLLAMA_HOST;
    while (host.endsWith('/')) host = host.slice(0, -1);
    this.host = host;
  }

  get detail(): string {
    return this.options.model;
  }

  /** Local only when the server is on this computer and the model is not an Ollama cloud model. */
  get egress() {
    return isCloudModel(this.options.model) || !isLoopback(this.host) ? ('cloud' as const) : ('local' as const);
  }

  /** The machine a non-local request goes to: the configured host, or ollama.com for a cloud model. */
  get recipient(): string | undefined {
    if (!isLoopback(this.host)) return hostName(this.host);
    return isCloudModel(this.options.model) ? 'ollama.com' : undefined;
  }

  async ask(request: AiRequest, signal: AbortSignal): Promise<AiResult> {
    const { model, http } = this.options;
    const timeoutMs = this.options.timeoutMs + (request.extraSeconds ?? 0) * 1000;
    if (signal.aborted) return { ok: false, kind: 'cancelled', message: 'Cancelled.' };
    if (!model.trim()) {
      return { ok: false, kind: 'not-installed', message: 'No Local model is set. Choose one in Threadglyph settings.' };
    }
    if (request.image) {
      const refusal = await this.visionRefusal(signal);
      if (refusal) return refusal;
    }

    const system = systemPromptFor(request);
    const content = buildPromptText(request);
    const user: Record<string, unknown> = { role: 'user', content };
    if (request.image) user.images = [request.image.data];
    const contextTokens = agentContextTokens(request, system.length + content.length);
    const body = JSON.stringify({
      model,
      stream: false,
      // Reasoning models answer far faster without thinking, and a comment reply rarely needs it.
      think: false,
      messages: [{ role: 'system', content: system }, user],
      ...(contextTokens ? { options: { num_ctx: contextTokens } } : {}),
    });

    const out = await http({ url: `${this.host}/api/chat`, method: 'POST', body, timeoutMs, signal });
    if (!out.ok) {
      if (out.reason === 'aborted') return { ok: false, kind: 'cancelled', message: 'Cancelled.' };
      if (out.reason === 'timeout') {
        return {
          ok: false,
          kind: 'timeout',
          message: `${model} did not answer within ${Math.round(timeoutMs / 1000)} seconds. Try a smaller model or raise the timeout.`,
        };
      }
      return {
        ok: false,
        kind: 'network',
        message: `Ollama is not reachable at ${this.host}. Start the Ollama app (or run \`ollama serve\`) and try again.`,
      };
    }
    if (out.status === 404) {
      return { ok: false, kind: 'not-installed', message: `The model ${model} is not installed. Run \`ollama pull ${model}\`.` };
    }
    let parsed: { message?: { content?: string }; error?: string };
    try {
      parsed = JSON.parse(out.text) as typeof parsed;
    } catch {
      return { ok: false, kind: 'failed', message: `Ollama returned HTTP ${out.status} with an unreadable body.` };
    }
    if (out.status !== 200 || parsed.error) {
      return { ok: false, kind: 'failed', message: `Ollama error (HTTP ${out.status}): ${(parsed.error ?? '').slice(0, 300)}` };
    }
    const text = stripThinking(parsed.message?.content ?? '');
    return text ? { ok: true, text } : { ok: false, kind: 'failed', message: `${model} returned an empty reply.` };
  }

  /**
   * Refuses before sending when the model reports it cannot see images, so a
   * text-only model never answers confidently about a picture it did not see.
   * If Ollama cannot say (older versions), the request goes ahead.
   */
  private async visionRefusal(signal: AbortSignal): Promise<AiResult | null> {
    const { model, http } = this.options;
    const out = await http({
      url: `${this.host}/api/show`,
      method: 'POST',
      body: JSON.stringify({ model }),
      timeoutMs: 15_000,
      signal,
    });
    if (!out.ok || out.status !== 200) return null;
    let capabilities: unknown;
    try {
      capabilities = (JSON.parse(out.text) as { capabilities?: unknown }).capabilities;
    } catch {
      return null;
    }
    if (!Array.isArray(capabilities) || capabilities.includes('vision')) return null;
    return {
      ok: false,
      kind: 'unsupported',
      message:
        `${model} cannot see images. Pull a vision model (\`ollama pull ${SUGGESTED_VISION_MODEL}\`) and set it as the ` +
        'Local model, or ask Gemini about this image.',
    };
  }
}
