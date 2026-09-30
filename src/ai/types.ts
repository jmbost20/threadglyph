import type { PreparedImage } from '../anchor/imageEmbed';
import type { MessageOrigin } from '../model/types';

/**
 * Provider-neutral AI boundary. The thread model and the panel know only these
 * types; each adapter maps them onto one provider or local tool.
 */

export interface AiCapabilities {
  text: true;
  /** Whether the adapter can send image bytes to a vision model. */
  images: boolean;
}

/** Where a request goes: `local` never leaves this computer. Shown in the preview before sending. */
export type AiEgress = 'local' | 'cloud';

export interface AiContextMessage {
  author: string;
  origin: MessageOrigin;
  body: string;
}

/** Exactly what is sent. Built from the user's explicit choices, shown before sending. */
export interface AiRequest {
  noteName: string;
  /** The anchored passage, for text threads. */
  quote: string | null;
  /** The anchored image's real bytes, for image threads. */
  image: PreparedImage | null;
  /** Extra note text the user chose to include (a section or the whole note). */
  context: { label: string; text: string } | null;
  messages: AiContextMessage[];
  /** Agent requests: the exact text the agent may propose changes to. */
  target?: { label: string; text: string } | null;
  /** Other notes the user allowed the agent to read. */
  vaultNotes?: { path: string; text: string }[];
  /** Extra seconds on top of the configured timeout, for requests that must write a lot (agent rewrites). */
  extraSeconds?: number;
}

export type AiErrorKind =
  | 'auth'
  | 'quota'
  | 'busy'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'not-installed'
  | 'unsupported'
  | 'failed';

export type AiResult = { ok: true; text: string } | { ok: false; kind: AiErrorKind; message: string };

export interface AiAdapter {
  /** Stable key, e.g. `local`; used to remember which assistant a request is for. */
  readonly id: string;
  /** Shown to the user, and used as the @mention name. */
  readonly name: string;
  /** The model or tool behind the name, e.g. `qwen3:8b`. */
  readonly detail: string;
  readonly egress: AiEgress;
  readonly capabilities: AiCapabilities;
  ask(request: AiRequest, signal: AbortSignal): Promise<AiResult>;
}
