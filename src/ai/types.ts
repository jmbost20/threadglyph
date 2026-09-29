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
}

export type AiErrorKind = 'auth' | 'quota' | 'network' | 'timeout' | 'cancelled' | 'not-installed' | 'unsupported' | 'failed';

export type AiResult = { ok: true; text: string } | { ok: false; kind: AiErrorKind; message: string };

export interface AiAdapter {
  readonly id: string;
  /** Shown to the user, and used as the @mention name. */
  readonly name: string;
  readonly capabilities: AiCapabilities;
  ask(request: AiRequest, signal: AbortSignal): Promise<AiResult>;
}
