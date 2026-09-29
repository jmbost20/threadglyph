import type { AiAdapter, AiErrorKind, AiRequest } from './types';

/** How much of the note goes with a request, chosen by the user in the preview. */
export type ContextScope = 'anchor' | 'section' | 'note';

/** Sends per thread before the user has to start over: one try plus two retries. */
export const MAX_ATTEMPTS = 3;

export type AiState =
  | { phase: 'preview'; scope: ContextScope; attempts: number }
  | { phase: 'running'; scope: ContextScope; attempts: number }
  | { phase: 'draft'; scope: ContextScope; attempts: number; text: string }
  | { phase: 'error'; scope: ContextScope; attempts: number; kind: AiErrorKind; message: string };

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

  open(threadId: string): void {
    if (!this.states.has(threadId)) this.states.set(threadId, { phase: 'preview', scope: 'anchor', attempts: 0 });
    this.onChange();
  }

  setScope(threadId: string, scope: ContextScope): void {
    const state = this.states.get(threadId);
    if (state?.phase !== 'preview') return;
    this.states.set(threadId, { ...state, scope });
    this.onChange();
  }

  canSend(threadId: string): boolean {
    const state = this.states.get(threadId);
    return !!state && state.phase !== 'running' && state.attempts < MAX_ATTEMPTS;
  }

  /** Sends (or retries) with the scope chosen in the preview. */
  async send(threadId: string, adapter: AiAdapter, build: (scope: ContextScope) => Promise<BuiltRequest>): Promise<void> {
    const state = this.states.get(threadId);
    if (!state || !this.canSend(threadId)) return;
    const attempts = state.attempts + 1;
    const controller = new AbortController();
    this.inFlight.set(threadId, controller);
    this.states.set(threadId, { phase: 'running', scope: state.scope, attempts });
    this.onChange();

    const settle = (next: AiState) => {
      // A cancel, close or newer send replaced this request: its answer is discarded.
      if (this.inFlight.get(threadId) !== controller) return;
      this.inFlight.delete(threadId);
      this.states.set(threadId, next);
      this.onChange();
    };

    const built = await build(state.scope);
    if (!built.ok) {
      settle({ phase: 'error', scope: state.scope, attempts, kind: 'unsupported', message: built.message });
      return;
    }
    if (built.request.image && !adapter.capabilities.images) {
      settle({ phase: 'error', scope: state.scope, attempts, kind: 'unsupported', message: `${adapter.name} cannot read images.` });
      return;
    }
    let result;
    try {
      result = await adapter.ask(built.request, controller.signal);
    } catch (err) {
      result = { ok: false as const, kind: 'failed' as const, message: `${adapter.name} failed: ${(err as Error).message}` };
    }
    if (result.ok) settle({ phase: 'draft', scope: state.scope, attempts, text: result.text });
    else if (result.kind === 'cancelled') settle({ phase: 'preview', scope: state.scope, attempts });
    else settle({ phase: 'error', scope: state.scope, attempts, kind: result.kind, message: result.message });
  }

  /** Stops a running request and returns to the preview. */
  cancel(threadId: string): void {
    const state = this.states.get(threadId);
    this.inFlight.get(threadId)?.abort();
    this.inFlight.delete(threadId);
    if (state) this.states.set(threadId, { phase: 'preview', scope: state.scope, attempts: state.attempts });
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
