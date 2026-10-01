import { Notice, type App, type Editor } from 'obsidian';
import type { AiAdapter } from '../ai/types';
import { ReadPermissionModal } from '../ui/modals';
import type { PreviewMark } from '../ui/agentPreview';
import type { ProposalView } from '../ui/proposalView';
import { STALE_MESSAGE, applyProposal, locateRegion, type Proposal } from './apply';
import type { ReadRequest } from './proposal';
import { capNote, isDailyNote, rankNotes, runAgent, type AgentIo, type VaultNote } from './vaultRead';

/** Where a proposal was asked for; it decides where it is shown. */
export type AgentSource = 'thread' | 'chat' | 'inline';

export interface AgentEntry {
  /** A thread id, or `chat:<n>` / `inline:<n>`. */
  key: string;
  source: AgentSource;
  notePath: string;
  reply: string;
  proposal: Proposal | null;
  error: string | null;
}

export interface AgentHost {
  app: App;
  /** The editor showing this note, opening the note if it is not open. */
  editorFor(notePath: string): Promise<Editor | null>;
  refresh(): void;
}

export const LOOSE_CAUTION = 'The agent did not quote your note word for word, so this change was matched by its first and last lines. Check the diff before accepting.';

/** How many notes a search looks through. */
const SEARCH_LIMIT = 2_000;

/**
 * Proposals waiting for Accept or Reject, for every surface. They hold note
 * text, so they live only in memory and are never written to thread records.
 */
export class AgentProposals {
  private readonly entries = new Map<string, AgentEntry>();

  constructor(private readonly host: AgentHost) {}

  set(entry: AgentEntry): void {
    this.entries.set(entry.key, entry);
    this.host.refresh();
  }

  forNote(notePath: string): AgentEntry[] {
    return [...this.entries.values()].filter((e) => e.notePath === notePath);
  }

  view(key: string): ProposalView | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    return {
      key,
      reply: entry.reply,
      diff: entry.proposal?.diff ?? null,
      error: entry.error,
      caution: entry.proposal?.loose ? LOOSE_CAUTION : null,
    };
  }

  /**
   * The previews to draw in a note whose text is `doc`. A note edited so the
   * proposal no longer fits turns it into an error (or drops it inline, where
   * the note is its only home).
   */
  previewMarks(notePath: string, doc: string): PreviewMark[] {
    const marks: PreviewMark[] = [];
    for (const entry of this.forNote(notePath)) {
      if (!entry.proposal) continue;
      const at = locateRegion(doc, entry.proposal.region);
      if (at === null) {
        if (entry.source === 'inline') this.entries.delete(entry.key);
        else this.entries.set(entry.key, { ...entry, proposal: null, error: STALE_MESSAGE });
        continue;
      }
      marks.push({ key: entry.key, from: at, to: at + entry.proposal.region.text.length, diff: entry.proposal.diff });
    }
    return marks;
  }

  /** Applies the proposal to its note as one undoable edit. */
  async accept(key: string): Promise<boolean> {
    const entry = this.entries.get(key);
    if (!entry?.proposal) return false;
    const editor = await this.host.editorFor(entry.notePath);
    if (!editor) {
      new Notice('Open the note to apply this change.');
      return false;
    }
    const applied = applyProposal(editor, entry.proposal);
    if (applied.ok) {
      this.entries.delete(key);
      new Notice('Change applied. Undo (⌘Z) in the note reverts it.');
    } else {
      this.entries.set(key, { ...entry, proposal: null, error: applied.message });
    }
    this.host.refresh();
    return applied.ok;
  }

  /** Drops the proposal; the note is never touched. */
  reject(key: string): void {
    if (this.entries.delete(key)) this.host.refresh();
  }

  clear(): void {
    this.entries.clear();
  }

  /** Permission prompt and note reading for one agent request made from `fromNote`. */
  io(adapter: AiAdapter, destination: string, fromNote: string): AgentIo {
    const { app } = this.host;
    const resolve = (name: string) => {
      const file = app.metadataCache.getFirstLinkpathDest(name.replace(/^\[\[|\]\]$/g, ''), fromNote);
      return file?.extension === 'md' ? file : null;
    };
    return {
      askPermission: (read: ReadRequest) =>
        new Promise<boolean>((done) => {
          const notes = read.notes.map((name) => {
            const file = resolve(name);
            return { name, path: file?.path ?? null, daily: !!file && isDailyNote(file.path) };
          });
          new ReadPermissionModal(app, { search: read.search, notes, destination, cloud: adapter.egress === 'cloud' }, done).open();
        }),
      readNotes: async (read: ReadRequest) => {
        const out: VaultNote[] = [];
        for (const name of read.notes) {
          const file = resolve(name);
          if (file && file.path !== fromNote) out.push(capNote(file.path, await app.vault.cachedRead(file)));
        }
        if (read.search) {
          const candidates: VaultNote[] = [];
          for (const file of app.vault.getMarkdownFiles().slice(0, SEARCH_LIMIT)) {
            if (file.path === fromNote || isDailyNote(file.path) || out.some((n) => n.path === file.path)) continue;
            candidates.push({ path: file.path, text: await app.vault.cachedRead(file) });
          }
          out.push(...rankNotes(read.search, candidates));
        }
        return out;
      },
    };
  }

  /** The adapter wrapped so one request can read other notes (with permission) before answering. */
  agentAdapter(adapter: AiAdapter, destination: string, fromNote: string): AiAdapter {
    const io = this.io(adapter, destination, fromNote);
    return {
      id: adapter.id,
      name: adapter.name,
      detail: adapter.detail,
      egress: adapter.egress,
      capabilities: adapter.capabilities,
      ask: (request, signal) => runAgent(adapter, request, signal, io),
    };
  }
}
