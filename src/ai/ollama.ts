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

  get egress() {
    return isCloudModel(this.options.model) ? ('cloud' as const) : ('local' as const);
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

    const user: Record<string, unknown> = { role: 'user', content: buildPromptText(request) };
    if (request.image) user.images = [request.image.data];
    const body = JSON.stringify({
      model,
      stream: false,
      // Reasoning models answer far faster without thinking, and a comment reply rarely needs it.
      think: false,
      messages: [{ role: 'system', content: systemPromptFor(request) }, user],
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
