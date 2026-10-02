import type { AiRequest, AiResult } from '../ai/types';
import type { Clock } from '../model/thread';
import type { ThreadRecord } from '../model/types';
import type { FileStore } from '../storage/threadStore';
import type { CardDelivery } from './anki';
import {
  addCardLinks,
  addEvidence,
  addToList,
  advance,
  byName,
  CARDS,
  cardSides,
  field,
  fileSafe,
  OBJECTS,
  rankCandidates,
  renderCard,
  renderObject,
  setField,
  summaryOf,
  type EvidenceEntry,
  type LearningState,
} from './objects';
import { conceptTitle } from './source';
import { instructionOf } from './trigger';
import { cardRequest, objectRequest, parseCardsReply, parseObjectReply } from './worker';
import type { Candidate, CardDraft, CardPlan, JobMessage, KnowledgeAction, KnowledgeJob, KnowledgeStatusView, ObjectProposal } from './types';

/** Private runtime folder for jobs; they hold quoted note text, so never the tracked records. */
export const JOBS_DIR = '.threadglyph/knowledge/jobs';

/** File access inside the knowledge folder. Nothing outside it is ever written. */
export interface KnowledgeVault {
  /** Markdown files directly inside `folder`. */
  list(folder: string): Promise<string[]>;
  read(path: string): Promise<string | null>;
  create(path: string, text: string): Promise<void>;
  /** Rewrites a file from its current text in one step (Obsidian's Vault.process). */
  process(path: string, change: (text: string) => string): Promise<void>;
  ensureFolder(path: string): Promise<void>;
}

export interface KnowledgeHost {
  jobs: FileStore;
  vault: KnowledgeVault;
  /** The knowledge folder, e.g. `Knowledge`. */
  folder(): string;
  /** Anki deck for new cards. */
  deck(): string;
  /** Asks the knowledge assistant; null when none is enabled. */
  ask(request: AiRequest, signal: AbortSignal): Promise<AiResult | null>;
  thread(id: string): ThreadRecord | undefined;
  /** Whether a job that waits for an answer may run now. */
  answered(job: KnowledgeJob): boolean;
  /** Anki delivery, or null to keep cards in the Obsidian inbox only. */
  delivery(): CardDelivery | null;
  clock: Clock;
  changed(): void;
  /** Whether knowledge workflows are on; while off, nothing runs and nothing is written. */
  enabled(): boolean;
}

export type ReviewDecision =
  | { kind: 'existing'; path: string }
  | { kind: 'new'; title: string; essence: string };

export interface EnqueueInput {
  action: KnowledgeAction;
  threadId: string;
  messageId: string;
  notePath: string;
  quote: string | null;
  context: { label: string; text: string } | null;
  excerpt?: string | null;
  heading?: string | null;
  request: string;
  waitForAnswer: boolean;
  /** Card choices made up front; without them a card request asks with the intake form. */
  plan?: CardPlan;
}

const jobPath = (id: string) => `${JOBS_DIR}/${id}.json`;
const today = (iso: string) => iso.slice(0, 10);
const noteLink = (path: string) => path.replace(/\.md$/, '');
const linkName = (path: string) => path.split('/').pop()!.replace(/\.md$/, '');

/**
 * Runs knowledge jobs one at a time, in order. Every step is saved before the
 * next starts, so after a restart a job resumes where it stopped: an object is
 * never created twice, and cards already written or delivered are not redone.
 */
export class KnowledgeCoordinator {
  private readonly jobs = new Map<string, KnowledgeJob>();
  private running: { id: string; abort: AbortController } | null = null;
  private draining = false;
  /** Set on unload: no further steps run or are saved. */
  private stopped = false;

  constructor(private readonly host: KnowledgeHost) {}

  async load(): Promise<void> {
    this.jobs.clear();
    for (const path of await this.host.jobs.list(JOBS_DIR)) {
      const raw = await this.host.jobs.read(path);
      try {
        const job = raw ? (JSON.parse(raw) as KnowledgeJob) : null;
        if (job?.schema !== 1 || !job.id) continue;
        // A job that was running when Obsidian closed runs again from its last saved step.
        if (job.state === 'running') job.state = 'queued';
        this.jobs.set(job.id, job);
      } catch {
        console.warn('[threadglyph] unreadable knowledge job', path);
      }
    }
  }

  all(): KnowledgeJob[] {
    return [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): KnowledgeJob | undefined {
    return this.jobs.get(id);
  }

  forThread(threadId: string): KnowledgeJob[] {
    return this.all().filter((j) => j.threadId === threadId);
  }

  /** One job per comment: asking again with the same comment returns the job it already has. */
  async enqueue(input: EnqueueInput): Promise<KnowledgeJob> {
    const key = `${input.threadId}:${input.messageId}`;
    const existing = this.all().find((j) => j.requestKey === key);
    if (existing) return existing;
    const now = this.host.clock.now();
    const job: KnowledgeJob = {
      schema: 1,
      id: this.host.clock.newId(),
      requestKey: key,
      revision: 1,
      ...input,
      state: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.save(job);
    this.kick();
    return job;
  }

  /** Runs an edited request again as a new revision; what the old one made stays. */
  async rerun(id: string, latest: Pick<EnqueueInput, 'action' | 'request' | 'quote' | 'context'>): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.state === 'running') return;
    const next: KnowledgeJob = { ...job, ...latest, revision: job.revision + 1, state: 'queued', waitForAnswer: false };
    delete next.result;
    delete next.proposal;
    delete next.candidates;
    delete next.cards;
    delete next.reason;
    await this.save(next);
    this.kick();
  }

  /** Tries a failed or waiting job again from the step where it stopped. */
  async retry(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || !['failed', 'waiting-anki', 'canceled'].includes(job.state)) return;
    await this.save({ ...job, state: 'queued', reason: undefined, waitForAnswer: false });
    this.kick();
  }

  /** Stops a job. Objects and cards it already made stay. */
  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.state === 'complete' || job.state === 'canceled') return;
    if (this.running?.id === id) this.running.abort.abort();
    await this.save({ ...job, state: 'canceled', reason: job.result ? 'Canceled. What it already made stays.' : 'Canceled.' });
  }

  /**
   * The owner's choice in the review or intake form: add to an existing object,
   * or make a new one; for a card request, also what cards to write.
   */
  async review(id: string, decision: ReviewDecision, plan?: CardPlan): Promise<void> {
    const found = this.jobs.get(id);
    if (!found || (found.state !== 'needs-review' && found.state !== 'needs-intake') || !found.proposal || !this.host.enabled()) return;
    const job: KnowledgeJob = plan ? { ...found, plan } : found;
    const proposal = found.proposal;
    try {
      const next = await this.publish(job, decision.kind === 'existing'
        ? { kind: 'existing', path: decision.path }
        : { kind: 'new', proposal: { ...proposal, title: decision.title.trim() || proposal.title, essence: decision.essence.trim() || proposal.essence } });
      await this.save({ ...next, state: 'queued', reason: undefined });
    } catch (err) {
      await this.save({ ...job, reason: (err as Error).message });
    }
    this.kick();
  }

  /**
   * Stops for good (the plugin is unloading). The running step is abandoned
   * unsaved; on the next load the job resumes, and finds anything it made.
   */
  stop(): void {
    this.stopped = true;
    this.running?.abort.abort();
  }

  /** Starts the next ready job unless one is running. Cheap; called whenever threads change. */
  kick(): void {
    if (this.draining || this.stopped || !this.host.enabled()) return;
    this.draining = true;
    void this.drain().finally(() => {
      this.draining = false;
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.stopped || !this.host.enabled()) return;
      const next = this.all().find((j) => j.state === 'queued' && (!j.waitForAnswer || this.host.answered(j)));
      if (!next) return;
      await this.run(next);
    }
  }

  private async run(start: KnowledgeJob): Promise<void> {
    const abort = new AbortController();
    this.running = { id: start.id, abort };
    let job: KnowledgeJob = { ...start, state: 'running', attempts: start.attempts + 1, reason: undefined };
    await this.save(job);
    try {
      if (!job.result) {
        job = await this.identify(job, abort.signal);
        if (job.state !== 'running') return;
      }
      if (job.action === 'card') {
        job = await this.writeCards(job, abort.signal);
        if (job.state !== 'running') return;
        job = await this.deliver(job, abort.signal);
        if (job.state !== 'running') return;
      }
      if (!abort.signal.aborted) await this.save({ ...job, state: 'complete' });
    } catch (err) {
      // Keep the steps saved before the error (cards already written, for example).
      if (!abort.signal.aborted) await this.save({ ...(this.jobs.get(job.id) ?? job), state: 'failed', reason: (err as Error).message });
    } finally {
      this.running = null;
    }
  }

  private async ask(request: AiRequest, signal: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; message: string; paused?: true }> {
    // Turned off meanwhile: the job waits, it has not failed.
    if (!this.host.enabled()) return { ok: false, message: 'Paused: knowledge workflows are off.', paused: true };
    // Cancel frees the queue at once, even if the assistant does not stop.
    const stopped = new Promise<AiResult>((resolve) => {
      if (signal.aborted) resolve({ ok: false, kind: 'cancelled', message: 'Canceled.' });
      signal.addEventListener('abort', () => resolve({ ok: false, kind: 'cancelled', message: 'Canceled.' }), { once: true });
    });
    const out = await Promise.race([this.host.ask(request, signal), stopped]);
    if (!this.host.enabled()) return { ok: false, message: 'Paused: knowledge workflows are off.', paused: true };
    if (!out) return { ok: false, message: 'No assistant is enabled for knowledge work. Turn on Local in Threadglyph settings.' };
    return out.ok ? out : { ok: false, message: out.message };
  }

  private discussion(job: KnowledgeJob): JobMessage[] {
    const thread = this.host.thread(job.threadId);
    return (thread?.messages ?? [])
      .filter((m) => !m.deletedAt)
      .map((m) => ({ author: m.author.name, ai: m.author.kind === 'ai', body: m.id === job.messageId ? instructionOf(m.body) || m.body : m.body }));
  }

  private async objects(): Promise<(Candidate & { aliases: string[] })[]> {
    const folder = `${this.host.folder()}/${OBJECTS}`;
    const found: (Candidate & { aliases: string[] })[] = [];
    for (const path of await this.host.vault.list(folder)) {
      const text = await this.host.vault.read(path);
      if (text !== null) found.push(summaryOf(path, text));
    }
    return found;
  }

  /** Proposes the object, then publishes it, or stops for review when it may be a duplicate. */
  private async identify(job: KnowledgeJob, signal: AbortSignal): Promise<KnowledgeJob> {
    // A run that made the object but stopped before saving finds it again instead of making a second one.
    const request = `${job.id}#${job.revision}`;
    for (const path of await this.host.vault.list(`${this.host.folder()}/${OBJECTS}`)) {
      const text = await this.host.vault.read(path);
      if (text !== null && field(text, 'created_by') === request) {
        return this.save({ ...job, result: { objectPath: path, objectTitle: summaryOf(path, text).title, created: true, cardPaths: [], delivered: {} } });
      }
    }
    const all = await this.objects();
    const discussion = this.discussion(job);
    const ranked = rankCandidates(all, [job.quote ?? '', job.request, ...discussion.map((m) => m.body)].join('\n'));
    const answer = await this.ask(objectRequest(job, linkName(job.notePath), discussion, ranked), signal);
    if (!answer.ok) return this.save({ ...job, state: answer.paused ? 'queued' : 'failed', reason: answer.message });
    let parsed = parseObjectReply(answer.text);
    if (!parsed.ok) return this.save({ ...job, state: 'failed', reason: parsed.message });
    // The highlight names the concept: never the note's or the section's name.
    const named = conceptTitle(parsed.proposal.title, job.quote, linkName(job.notePath));
    if (named.title !== parsed.proposal.title) {
      // It wrote about something else in the section: ask once more, about the highlighted concept.
      const again = await this.ask(objectRequest(job, linkName(job.notePath), discussion, ranked, named.title), signal);
      if (!again.ok && again.paused) return this.save({ ...job, state: 'queued', reason: again.message });
      const retried = again.ok ? parseObjectReply(again.text) : null;
      if (retried?.ok) parsed = { ok: true, proposal: { ...retried.proposal, title: named.title } };
    }
    const aliases = [...parsed.proposal.aliases, ...(named.alias ? [named.alias] : [])].filter((a, i, all) => a.toLowerCase() !== named.title.toLowerCase() && all.indexOf(a) === i);
    const proposal = { ...parsed.proposal, title: named.title, aliases };
    const matched = proposal.match ? byName(all, proposal.match) : null;
    const sameName = byName(all, proposal.title) ?? proposal.aliases.map((a) => byName(all, a)).find(Boolean) ?? null;
    if (job.action === 'card' && !job.plan) {
      // One form for a card request: the concept, where it goes, and what cards to write.
      const suspect = matched ?? sameName;
      const candidates = suspect ? [suspect, ...ranked.filter((c) => c.path !== suspect.path)].slice(0, 4) : [];
      return this.save({
        ...job,
        proposal,
        candidates: candidates.map(({ path, title, essence }) => ({ path, title, essence })),
        suggest: suspect && (matched === suspect ? proposal.confidence !== 'none' : true) ? suspect.path : 'new',
        state: 'needs-intake',
        reason: suspect ? `Choose the cards. “${suspect.title}” already exists.` : 'Choose the cards.',
      });
    }
    if (matched && proposal.confidence === 'high') {
      return this.save(await this.publish({ ...job, proposal }, { kind: 'existing', path: matched.path }));
    }
    const suspect = matched ?? sameName;
    if (suspect) {
      const candidates = [suspect, ...ranked.filter((c) => c.path !== suspect.path)].slice(0, 4);
      return this.save({
        ...job,
        proposal,
        candidates: candidates.map(({ path, title, essence }) => ({ path, title, essence })),
        suggest: suspect.path,
        state: 'needs-review',
        reason: `This may be “${suspect.title}”, which already exists.`,
      });
    }
    return this.save(await this.publish({ ...job, proposal }, { kind: 'new', proposal }));
  }

  private evidence(job: KnowledgeJob): EvidenceEntry {
    return {
      date: today(this.host.clock.now()),
      noteLink: noteLink(job.notePath),
      threadId: job.threadId,
      quote: job.quote,
      excerpt: job.excerpt ?? null,
      heading: job.heading ?? null,
      action: job.action,
      instruction: instructionOf(job.request),
    };
  }

  private learning(job: KnowledgeJob): LearningState {
    const messages = this.host.thread(job.threadId)?.messages.filter((m) => !m.deletedAt) ?? [];
    return messages.length > 1 || messages.some((m) => m.author.kind === 'ai') ? 'discussed' : 'captured';
  }

  private async publish(
    job: KnowledgeJob,
    target: { kind: 'existing'; path: string } | { kind: 'new'; proposal: ObjectProposal },
  ): Promise<KnowledgeJob> {
    const evidence = this.evidence(job);
    const learning = this.learning(job);
    if (target.kind === 'existing') {
      const mark = `%%threadglyph ${job.id}#${job.revision}%%`;
      await this.host.vault.process(target.path, (text) => {
        // A resumed run that already added this evidence does not add it twice.
        if (text.includes(mark)) return text;
        let next = addEvidence(text, { ...evidence, mark }, job.proposal?.keyIdeas ?? []);
        next = addToList(next, 'source_refs', `[[${evidence.noteLink}]]`);
        next = setField(next, 'updated', evidence.date);
        return setField(next, 'learning_state', advance(field(next, 'learning_state'), learning));
      });
      const title = summaryOf(target.path, (await this.host.vault.read(target.path)) ?? '').title;
      return { ...job, result: { objectPath: target.path, objectTitle: title, created: false, cardPaths: [], delivered: {} } };
    }
    const folder = `${this.host.folder()}/${OBJECTS}`;
    await this.host.vault.ensureFolder(folder);
    const request = `${job.id}#${job.revision}`;
    const base = fileSafe(target.proposal.title);
    let path = `${folder}/${base}.md`;
    for (let n = 2; (await this.host.vault.read(path)) !== null; n++) path = `${folder}/${base} ${n}.md`;
    const koId = `ko-${this.host.clock.newId().replace(/-/g, '').slice(0, 12)}`;
    await this.host.vault.create(path, setField(renderObject({ koId, proposal: target.proposal, learning, evidence }), 'created_by', request));
    return { ...job, proposal: target.proposal, result: { objectPath: path, objectTitle: target.proposal.title, created: true, cardPaths: [], delivered: {} } };
  }

  /** Writes the cards from the published object (what was read and discussed), not from the raw source. */
  private async writeCards(job: KnowledgeJob, signal: AbortSignal): Promise<KnowledgeJob> {
    const result = job.result!;
    let drafts = job.cards;
    if (!drafts) {
      const objectText = await this.host.vault.read(result.objectPath);
      if (objectText === null) return this.save({ ...job, state: 'failed', reason: `The object ${result.objectPath} is missing.` });
      const plan = job.plan ?? { type: job.proposal?.cardType ?? 'concept', count: job.proposal?.cardCount ?? 1, note: '' };
      const answer = await this.ask(cardRequest(result.objectPath, objectText, plan, instructionOf(job.request)), signal);
      if (!answer.ok) return this.save({ ...job, state: answer.paused ? 'queued' : 'failed', reason: answer.message });
      const cards = parseCardsReply(answer.text);
      if (!cards.length) return this.save({ ...job, state: 'failed', reason: 'The assistant wrote no usable cards.' });
      drafts = cards.map((c) => ({ ...c, cardId: this.host.clock.newId().replace(/-/g, '').slice(0, 10) }));
      job = await this.save({ ...job, cards: drafts });
    }
    const folder = `${this.host.folder()}/${CARDS}`;
    await this.host.vault.ensureFolder(folder);
    const written = [...result.cardPaths];
    for (const draft of drafts) {
      const path = `${folder}/${fileSafe(result.objectTitle)} · ${draft.cardId}.md`;
      if (written.includes(path)) continue;
      if ((await this.host.vault.read(path)) === null) {
        await this.host.vault.create(path, renderCard({
          cardId: draft.cardId,
          card: draft,
          objectLink: linkName(result.objectPath),
          sourceLink: noteLink(job.notePath),
          deck: this.host.deck(),
          date: today(this.host.clock.now()),
        }));
      }
      written.push(path);
      job = await this.save({ ...job, result: { ...job.result!, cardPaths: written } });
    }
    // Links every card the object does not list yet, including ones written before a restart.
    await this.host.vault.process(result.objectPath, (text) => {
      const missing = written.map(linkName).filter((name) => !text.includes(`[[${name}]]`));
      if (!missing.length) return text;
      let next = addCardLinks(text, missing);
      for (const name of missing) next = addToList(next, 'card_refs', `[[${name}]]`);
      return setField(next, 'learning_state', 'carded');
    });
    return job;
  }

  /** Sends cards not yet in Anki; a closed Anki leaves the job waiting, with the cards safe in the inbox. */
  private async deliver(job: KnowledgeJob, signal: AbortSignal): Promise<KnowledgeJob> {
    const delivery = this.host.delivery();
    if (!delivery) return job;
    const result = job.result!;
    const delivered = { ...result.delivered };
    for (const path of result.cardPaths) {
      if (delivered[path]) continue;
      const text = await this.host.vault.read(path);
      const sides: CardDraft | null = text ? cardSides(text) : null;
      const cardId = text ? field(text, 'card_id') : null;
      if (!sides || typeof cardId !== 'string') continue;
      const deck = field(text!, 'deck');
      const out = await delivery.deliver({ cardId, ...sides, deck: typeof deck === 'string' && deck ? deck : this.host.deck() }, signal);
      if (!out.ok) {
        return this.save({ ...job, result: { ...result, delivered }, state: out.unavailable ? 'waiting-anki' : 'failed', reason: out.message });
      }
      delivered[path] = out.noteId;
      await this.host.vault.process(path, (t) => setField(setField(t, 'delivery', 'anki'), 'anki_note_id', String(out.noteId)));
      job = await this.save({ ...job, result: { ...result, delivered } });
    }
    return job;
  }

  private async save(job: KnowledgeJob): Promise<KnowledgeJob> {
    if (this.stopped) return job;
    // A job canceled while it ran still records what it made, but stays canceled.
    const canceled = this.jobs.get(job.id)?.state === 'canceled' && job.state !== 'queued';
    const next = { ...job, ...(canceled ? { state: 'canceled' as const, reason: this.jobs.get(job.id)!.reason } : {}), updatedAt: this.host.clock.now() };
    this.jobs.set(next.id, next);
    await this.host.jobs.ensureDir(JOBS_DIR);
    await this.host.jobs.write(jobPath(next.id), JSON.stringify(next, null, 2));
    this.host.changed();
    return next;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How a job reads on its thread card. `currentBody` is the request comment as it is now. */
export function statusView(job: KnowledgeJob, currentBody: string | null): KnowledgeStatusView {
  const r = job.result;
  const object = r ? `“${r.objectTitle}”` : '';
  const cards = r?.cardPaths.length ?? 0;
  const sent = r ? Object.keys(r.delivered).length : 0;
  const texts: Record<KnowledgeStatusView['state'], string> = {
    queued: job.waitForAnswer ? 'Waiting for the answer, then queued' : 'Queued',
    running: r ? (job.action === 'card' ? `Writing cards for ${object}…` : 'Saving…') : 'Reading the passage…',
    'needs-review': job.reason ?? 'Needs your review',
    'needs-intake': job.reason ?? 'Choose the cards.',
    'waiting-anki': `${plural(cards, 'card')} in the inbox; ${job.reason ?? 'waiting for Anki'}`,
    complete: !r
      ? 'Done'
      : job.action === 'card'
        ? `${plural(cards, 'card')} from ${object}${sent ? `, ${sent} in Anki` : ', in the card inbox'}`
        : `${r.created ? 'Created' : 'Added to'} ${object}`,
    failed: `Failed: ${job.reason ?? 'unknown error'}`,
    canceled: job.reason ?? 'Canceled',
  };
  return {
    jobId: job.id,
    action: job.action,
    state: job.state,
    text: texts[job.state],
    objectPath: r?.objectPath ?? null,
    cardPaths: r?.cardPaths ?? [],
    stale: currentBody !== null && currentBody.trim() !== job.request.trim() && job.state !== 'running' && job.state !== 'queued',
  };
}
