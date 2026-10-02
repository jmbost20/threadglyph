import type { AssistantId } from '../ai/assistants';
import { DEFAULT_ANKI_NOTE_TYPE, DEFAULT_ANKI_URL } from './anki';

export interface KnowledgeSettings {
  /** Off by default: @knowledge and @card are plain text until this is on. */
  knowledgeEnabled: boolean;
  /** Vault folder for Knowledge Objects and cards; nothing outside it is written. */
  knowledgeFolder: string;
  /**
   * Who does knowledge work. It runs in the background without a preview, so
   * the default stays on this computer.
   */
  knowledgeAssistant: AssistantId;
  /** Send new cards to Anki (AnkiConnect); off keeps them in the Obsidian card inbox. */
  ankiDelivery: boolean;
  ankiDeck: string;
  ankiNoteType: string;
  ankiUrl: string;
}

export const DEFAULT_KNOWLEDGE_SETTINGS: KnowledgeSettings = {
  knowledgeEnabled: false,
  knowledgeFolder: 'Knowledge',
  knowledgeAssistant: 'local',
  ankiDelivery: false,
  ankiDeck: 'Threadglyph Inbox',
  ankiNoteType: DEFAULT_ANKI_NOTE_TYPE,
  ankiUrl: DEFAULT_ANKI_URL,
};

const ASSISTANTS: AssistantId[] = ['local', 'gemini', 'claude'];

/** Saved knowledge settings, with defaults for anything missing or malformed. */
export function migrateKnowledgeSettings(saved: Record<string, unknown>): KnowledgeSettings {
  const d = DEFAULT_KNOWLEDGE_SETTINGS;
  const text = (key: keyof KnowledgeSettings) => {
    const v = saved[key];
    return typeof v === 'string' && v.trim() ? v.trim() : (d[key] as string);
  };
  return {
    knowledgeEnabled: saved.knowledgeEnabled === true,
    knowledgeFolder: text('knowledgeFolder').replace(/^\/+|\/+$/g, '') || d.knowledgeFolder,
    knowledgeAssistant: ASSISTANTS.includes(saved.knowledgeAssistant as AssistantId) ? (saved.knowledgeAssistant as AssistantId) : d.knowledgeAssistant,
    ankiDelivery: saved.ankiDelivery === true,
    ankiDeck: text('ankiDeck'),
    ankiNoteType: text('ankiNoteType'),
    ankiUrl: text('ankiUrl'),
  };
}

const quoted = (s: string) => JSON.stringify(s);

/**
 * An Obsidian Bases file listing the objects and the card inbox. With
 * `selected`, a first "Selected" view shows just those notes (one concept and
 * the cards made with it), which is what Open shows.
 */
export function knowledgeBase(folder: string, selected: string[] = []): string {
  const focus = selected.length
    ? [
        '  - type: table',
        '    name: Selected',
        '    filters:',
        '      or:',
        ...selected.map((path) => `        - file.path == ${quoted(path)}`),
        '    order:',
        '      - file.name',
        '      - type',
        '      - ko_id',
        '      - learning_state',
        '      - object',
        '      - delivery',
      ]
    : [];
  return [
    'properties:',
    '  file.name:',
    '    displayName: Concept',
    '  ko_id:',
    '    displayName: ID',
    'views:',
    ...focus,
    '  - type: table',
    '    name: Objects',
    '    filters:',
    '      and:',
    `        - file.inFolder("${folder}/Objects")`,
    '    order:',
    '      - file.name',
    '      - ko_id',
    '      - kind',
    '      - learning_state',
    '      - review_state',
    '      - source_refs',
    '      - updated',
    '  - type: table',
    '    name: Card inbox',
    '    filters:',
    '      and:',
    `        - file.inFolder("${folder}/Cards")`,
    '    order:',
    '      - file.name',
    '      - object',
    '      - delivery',
    '      - deck',
    '      - created',
    '',
  ].join('\n');
}
