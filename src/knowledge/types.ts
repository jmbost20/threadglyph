/**
 * Knowledge workflows: an owner comment that says @knowledge or @card becomes a
 * job. The job turns the commented passage and its discussion into a Knowledge
 * Object (a note in the knowledge folder), and for @card, flashcards written
 * from that object, never from unread source text.
 *
 * Jobs hold quoted note text, so they live in the private `.threadglyph` folder,
 * never in the tracked thread records.
 */

export type KnowledgeAction = 'knowledge' | 'card';

export type JobState =
  /** Waiting its turn, or for the assistant's answer the same comment asked for. */
  | 'queued'
  | 'running'
  /** A possible duplicate object: the owner decides in the review form. */
  | 'needs-review'
  /** The object and cards exist; Anki was not reachable to deliver them. */
  | 'waiting-anki'
  | 'complete'
  | 'failed'
  | 'canceled';

export interface JobMessage {
  author: string;
  ai: boolean;
  body: string;
}

/** What the worker proposes for the object; edited by the owner in the review form. */
export interface ObjectProposal {
  title: string;
  aliases: string[];
  kind: string;
  domains: string[];
  essence: string;
  keyIdeas: string[];
  /** The existing object the worker says this is, by title, and how sure it is. */
  match: string | null;
  confidence: 'high' | 'low' | 'none';
}

export interface Candidate {
  path: string;
  title: string;
  essence: string;
}

export interface CardDraft {
  front: string;
  back: string;
}

export interface JobResult {
  objectPath: string;
  objectTitle: string;
  /** False when the job added to an object that already existed. */
  created: boolean;
  cardPaths: string[];
  /** Cards Anki confirmed, by card file path. */
  delivered: Record<string, number>;
}

export interface KnowledgeJob {
  schema: 1;
  id: string;
  /** One job per comment: `threadId:messageId`. */
  requestKey: string;
  /** Bumped when the owner runs an edited request again. */
  revision: number;
  action: KnowledgeAction;
  threadId: string;
  messageId: string;
  notePath: string;
  /** The commented passage, captured when the request was made. */
  quote: string | null;
  /** The section around the passage, captured with it. */
  context: { label: string; text: string } | null;
  /** The comment that asked, as it was when the job was made. */
  request: string;
  /** Run after the assistant this comment also asked has answered (or the request was closed). */
  waitForAnswer: boolean;
  state: JobState;
  /** Why it stopped, for failed, waiting and review states. */
  reason?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  proposal?: ObjectProposal;
  candidates?: Candidate[];
  /** Cards the worker wrote, kept so a retry writes the same ones. */
  cards?: (CardDraft & { cardId: string })[];
  result?: JobResult;
}

/** One job as a thread card shows it. */
export interface KnowledgeStatusView {
  jobId: string;
  action: KnowledgeAction;
  state: JobState;
  /** e.g. "Added to Eventual consistency" or "2 cards in the inbox". */
  text: string;
  objectPath: string | null;
  cardPaths: string[];
  /** The comment changed after this job ran. */
  stale: boolean;
}
