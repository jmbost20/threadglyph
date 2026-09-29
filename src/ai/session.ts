import type { AiAdapter, AiErrorKind, AiRequest } from './types';

/** How much of the note goes with a request, chosen by the user in the preview. */
export type ContextScope = 'anchor' | 'section' | 'note';

/** Sends per thread before the user has to start over: one try plus two retries. */
export const MAX_ATTEMPTS = 3;

/** Fields every phase carries: the chosen scope and assistant, and how many sends were made. */
interface AiBase {
  scope: ContextScope;
  /** Id of the assistant this request is for, e.g. `local`. */
  assistant: string;
  attempts: number;
}

export type AiState =
  | (AiBase & { phase: 'preview' })
  | (AiBase & { phase: 'running' })
  | (AiBase & { phase: 'draft'; text: string })
  | (AiBase & { phase: 'error'; kind: AiErrorKind; message: string });

export type BuiltRequest = { ok: true; request: AiRequest } | { ok: false; message: string };

/**
 * Per-thread "Ask AI" state: preview → running → draft (or error). Nothing is
 * written to the thread here; a draft only becomes a message when the user
 * adopts it. A cancelled or superseded request's late answer is dropped, so a
 * retry can never produce two replies.
 */
export class AiSessions {
  private readonly states = new Map<string, AiState>();
  private readonly inFlight = new Map<string, AbortController>();

  constructor(private readonly onChange: () => void) {}

  get(threadId: string): AiState | undefined {
    return this.states.get(threadId);
  }

  /**
   * Opens the preview for `assistant`. A preview or a failed request switches
   * to it (as a fresh request); a running request or an unadopted draft is
   * left alone.
   */
  open(threadId: string, assistant: string): void {
    const state = this.states.get(threadId);
    if (!state) this.states.set(threadId, { phase: 'preview', scope: 'anchor', assistant, attempts: 0 });
    else if (state.assistant !== assistant) return this.setAssistant(threadId, assistant);
    this.onChange();
  }

  setScope(threadId: string, scope: ContextScope): void {
    const state = this.states.get(threadId);
    if (state?.phase !== 'preview') return;
    this.states.set(threadId, { ...state, scope });
    this.onChange();
  }

  /** Picks another assistant while previewing, or after an error to try a different one. */
  setAssistant(threadId: string, assistant: string): void {
    const state = this.states.get(threadId);
    if (state?.phase !== 'preview' && state?.phase !== 'error') return;
    // A different assistant is a fresh request, with its own retries.
    this.states.set(threadId, { phase: 'preview', scope: state.scope, assistant, attempts: 0 });
    this.onChange();
  }

  canSend(threadId: string): boolean {
    const state = this.states.get(threadId);
    return !!state && state.phase !== 'running' && state.attempts < MAX_ATTEMPTS;
  }

  /**
   * Sends (or retries) with the scope and assistant chosen in the preview.
   * `find` maps the assistant id to its adapter; null when it has since been switched off.
   */
  async send(
    threadId: string,
    find: (assistant: string) => AiAdapter | null,
    build: (scope: ContextScope) => Promise<BuiltRequest>,
  ): Promise<void> {
    const state = this.states.get(threadId);
    if (!state || !this.canSend(threadId)) return;
    const base = { scope: state.scope, assistant: state.assistant, attempts: state.attempts + 1 };
    const controller = new AbortController();
    this.inFlight.set(threadId, controller);
    this.states.set(threadId, { ...base, phase: 'running' });
    this.onChange();

    const settle = (next: AiState) => {
      // A cancel, close or newer send replaced this request: its answer is discarded.
      if (this.inFlight.get(threadId) !== controller) return;
      this.inFlight.delete(threadId);
      this.states.set(threadId, next);
      this.onChange();
    };

    let built: BuiltRequest;
    try {
      built = await build(state.scope);
    } catch (err) {
      // e.g. the note or image became unreadable after the checks; never leave the card spinning.
      built = { ok: false, message: `Could not prepare the request: ${(err as Error).message}` };
    }
    if (!built.ok) {
      settle({ ...base, phase: 'error', kind: 'unsupported', message: built.message });
      return;
    }
    const adapter = find(state.assistant);
    if (!adapter) {
      settle({ ...base, phase: 'error', kind: 'unsupported', message: 'That assistant is switched off. Choose another one.' });
      return;
    }
    if (built.request.image && !adapter.capabilities.images) {
      settle({ ...base, phase: 'error', kind: 'unsupported', message: `${adapter.name} cannot read images.` });
      return;
    }
    let result;
    try {
      result = await adapter.ask(built.request, controller.signal);
    } catch (err) {
      result = { ok: false as const, kind: 'failed' as const, message: `${adapter.name} failed: ${(err as Error).message}` };
    }
    if (result.ok) settle({ ...base, phase: 'draft', text: result.text });
    else if (result.kind === 'cancelled') settle({ ...base, phase: 'preview' });
    else settle({ ...base, phase: 'error', kind: result.kind, message: result.message });
  }

  /** Stops a running request and returns to the preview. */
  cancel(threadId: string): void {
    const state = this.states.get(threadId);
    this.inFlight.get(threadId)?.abort();
    this.inFlight.delete(threadId);
    if (state) this.states.set(threadId, { phase: 'preview', scope: state.scope, assistant: state.assistant, attempts: state.attempts });
    this.onChange();
  }

  /** Ends the session (discard, or after the draft was added to the thread). */
  close(threadId: string): void {
    this.inFlight.get(threadId)?.abort();
    this.inFlight.delete(threadId);
    this.states.delete(threadId);
    this.onChange();
  }

  closeAll(): void {
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    this.states.clear();
  }
}
