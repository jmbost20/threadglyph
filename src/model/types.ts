/**
 * Threadglyph domain types.
 *
 * Storage is split in two so a vault's Git history never carries note text:
 * - ThreadRecord (tracked): ids, authorship, messages, state. No quoted note content.
 * - TextAnchor (local-only): the quoted selection and its surrounding context.
 */

export const SCHEMA_VERSION = 1;

export type AuthorKind = 'human' | 'ai';

export interface Author {
  kind: AuthorKind;
  name: string;
}

/** A prior body of a message, kept so edits are recoverable. */
export interface MessageRevision {
  body: string;
  /** When this body was replaced. */
  replacedAt: string;
}

/**
 * `ai` is an untouched model response. `ai-edited` marks model output that a
 * human revised, so edited AI text is never presented as a raw model reply.
 */
export type MessageOrigin = 'human' | 'ai' | 'ai-edited';

export interface Message {
  id: string;
  author: Author;
  origin: MessageOrigin;
  createdAt: string;
  body: string;
  editedAt?: string;
  revisions: MessageRevision[];
}

export type ThreadStatus = 'open' | 'resolved';

export type AnchorKind = 'text' | 'image';

export interface ThreadRecord {
  schema: typeof SCHEMA_VERSION;
  id: string;
  notePath: string;
  anchorKind: AnchorKind;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  /** Incremented on every save; used to detect stale edits. */
  revision: number;
  messages: Message[];
}

/**
 * Where a thread points. For `image` threads the quote is the embed markup
 * (e.g. `![[diagram.png]]`) and `imagePath` is the embedded file, which lets
 * the thread follow the image through renames. Both stay in the local-only file.
 */
export interface TextAnchor {
  schema: typeof SCHEMA_VERSION;
  threadId: string;
  kind: AnchorKind;
  notePath: string;
  /** Vault path of the embedded image; present exactly when `kind` is `image`. */
  imagePath?: string;
  quote: string;
  prefix: string;
  suffix: string;
  /** 0-based line of the quote when captured. A hint only, never authoritative. */
  lineHint: number;
}
