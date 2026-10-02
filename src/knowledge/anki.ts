import type { HttpFn } from '../ai/http';

/**
 * Delivers a card to Anki through the AnkiConnect add-on on this computer.
 * Each card carries a `threadglyph::<card id>` tag, so a retry after a lost
 * answer finds the note it already made instead of adding a second one.
 */

export interface DeliverCard {
  cardId: string;
  front: string;
  back: string;
  deck: string;
}

export type Delivery =
  | { ok: true; noteId: number; existed: boolean }
  /** `unavailable`: Anki is closed or AnkiConnect is missing; try again later. */
  | { ok: false; unavailable: boolean; message: string };

export interface CardDelivery {
  deliver(card: DeliverCard, signal: AbortSignal): Promise<Delivery>;
}

export const DEFAULT_ANKI_URL = 'http://127.0.0.1:8765';
export const DEFAULT_ANKI_NOTE_TYPE = 'Basic';

export const cardTag = (cardId: string) => `threadglyph::${cardId}`;

export class AnkiConnect implements CardDelivery {
  constructor(
    private readonly http: HttpFn,
    private readonly url: string = DEFAULT_ANKI_URL,
    private readonly noteType: string = DEFAULT_ANKI_NOTE_TYPE,
  ) {}

  private async call(action: string, params: Record<string, unknown>, signal: AbortSignal): Promise<{ ok: true; result: unknown } | { ok: false; unavailable: boolean; message: string }> {
    const out = await this.http({ url: this.url, method: 'POST', body: JSON.stringify({ action, version: 6, params }), timeoutMs: 15_000, signal });
    if (!out.ok) return { ok: false, unavailable: true, message: `Anki is not reachable (${out.message}). Open Anki with AnkiConnect, then Check again.` };
    try {
      const data = JSON.parse(out.text) as { result: unknown; error: string | null };
      if (data.error) return { ok: false, unavailable: false, message: `Anki refused the card: ${data.error}` };
      return { ok: true, result: data.result };
    } catch {
      return { ok: false, unavailable: true, message: 'Anki answered with something that is not AnkiConnect.' };
    }
  }

  async deliver(card: DeliverCard, signal: AbortSignal): Promise<Delivery> {
    const found = await this.call('findNotes', { query: `"tag:${cardTag(card.cardId)}"` }, signal);
    if (!found.ok) return found;
    const ids = Array.isArray(found.result) ? (found.result as number[]) : [];
    if (ids.length) return { ok: true, noteId: ids[0], existed: true };
    const deck = await this.call('createDeck', { deck: card.deck }, signal);
    if (!deck.ok) return deck;
    const added = await this.call(
      'addNote',
      {
        note: {
          deckName: card.deck,
          modelName: this.noteType,
          fields: { Front: card.front, Back: card.back },
          tags: ['threadglyph', cardTag(card.cardId)],
          options: { allowDuplicate: false },
        },
      },
      signal,
    );
    if (!added.ok) return added;
    return typeof added.result === 'number'
      ? { ok: true, noteId: added.result, existed: false }
      : { ok: false, unavailable: false, message: 'Anki did not return the new note.' };
  }
}
