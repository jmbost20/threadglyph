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
  /** `notice` explains why a Send came back to the preview instead of going out. */
  | (AiBase & { phase: 'preview'; notice?: string })
  | (AiBase & { phase: 'running' })
  | (AiBase & { phase: 'saving'; text: string })
  | (AiBase & { phase: 'draft'; text: string })
  | (AiBase & { phase: 'error'; kind: AiErrorKind; message: string });

/**
 * The request to send, or why it can't go. `stale` means it no longer matches what the
 * preview showed, so nothing is sent and the preview is shown again (no retry is used).
 */
export type BuiltRequest = { ok: true; request: AiRequest } | { ok: false; message: string; stale?: boolean };

/**
 * Per-thread Ask AI state. Successful answers are saved through the caller's
 * persistence boundary; a failed save leaves a recoverable draft. Late answers
 * from cancelled or superseded requests are dropped.
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
    if (!state) this.states.set(threadId, { phase: 'preview', scope: 'section', assistant, attempts: 0 });
    else if (state.assistant !== assistant) return this.setAssistant(threadId, assistant);
    this.onChange();
  }

  setScope(threadId: string, scope: ContextScope): void {
    const state = this.states.get(threadId);
    if (state?.phase !== 'preview') return;
    // A new choice is a new review, so an earlier "changed since" notice no longer applies.
    this.states.set(threadId, { phase: 'preview', scope, assistant: state.assistant, attempts: state.attempts });
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
    return !!state && state.phase !== 'running' && state.phase !== 'saving' && state.attempts < MAX_ATTEMPTS;
  }

  /**
   * Sends (or retries) with the scope and assistant chosen in the preview.
   * `find` maps the assistant id to its adapter; null when it has since been switched off.
   */
  async send(
    threadId: string,
    find: (assistant: string) => AiAdapter | null,
    build: (scope: ContextScope) => Promise<BuiltRequest>,
    publish?: (assistant: string, body: string, edited: boolean) => Promise<boolean>,
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
      if (this.inFlight.get(threadId) !== controller) return false;
      this.inFlight.delete(threadId);
      this.states.set(threadId, next);
      this.onChange();
      return true;
    };

    let built: BuiltRequest;
    try {
      built = await build(state.scope);
    } catch (err) {
      // e.g. the note or image became unreadable after the checks; never leave the card spinning.
      built = { ok: false, message: `Could not prepare the request: ${(err as Error).message}` };
    }
    if (!built.ok) {
      if (built.stale) settle({ ...base, attempts: state.attempts, phase: 'preview', notice: built.message });
      else settle({ ...base, phase: 'error', kind: 'unsupported', message: built.message });
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
    if (result.ok) {
      const current = settle({ ...base, phase: 'draft', text: result.text });
      if (current && publish) await this.adopt(threadId, result.text, publish);
    }
    else if (result.kind === 'cancelled') settle({ ...base, phase: 'preview' });
    else settle({ ...base, phase: 'error', kind: result.kind, message: result.message });
  }

  /** One persistence operation at a time, including recovery after a failed auto-save. */
  async adopt(
    threadId: string,
    body: string,
    publish: (assistant: string, body: string, edited: boolean) => Promise<boolean>,
  ): Promise<boolean> {
    const draft = this.states.get(threadId);
    if (draft?.phase !== 'draft' || !body.trim()) return false;
    const saving: AiState = { ...draft, phase: 'saving' };
    this.states.set(threadId, saving);
    this.onChange();
    let saved = false;
    try {
      saved = await publish(draft.assistant, body, body.trim() !== draft.text.trim());
    } finally {
      // Unloading can clear the session while the already-started disk write finishes.
      if (this.states.get(threadId) === saving) {
        if (saved) this.states.delete(threadId);
        else this.states.set(threadId, draft);
        this.onChange();
      }
    }
    return saved;
  }

  /** Stops a running request and returns to the preview. */
  cancel(threadId: string): void {
    const state = this.states.get(threadId);
    if (state?.phase === 'saving') return;
    this.inFlight.get(threadId)?.abort();
    this.inFlight.delete(threadId);
    if (state) this.states.set(threadId, { phase: 'preview', scope: state.scope, assistant: state.assistant, attempts: state.attempts });
    this.onChange();
  }

  /** Ends the session (discard, or after the draft was added to the thread). */
  close(threadId: string): void {
    if (this.states.get(threadId)?.phase === 'saving') return;
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
