import type { PreparedImage } from '../anchor/imageEmbed';
import type { ThreadRecord } from '../model/types';
import { agentTarget, type Region } from '../agent/target';
import { MAX_CONTEXT_CHARS, sectionAround, wholeNote } from './context';
import { AGENT_SYSTEM_PROMPT, SYSTEM_PROMPT, buildPromptText } from './prompt';
import type { ContextScope } from './session';
import type { AiRequest } from './types';

/** Everything known about a thread when an AI request is prepared. */
export interface RequestInputs {
  noteName: string;
  /** Current note text. */
  doc: string;
  thread: ThreadRecord;
  /** The anchored passage as it reads now, or as captured when it can no longer be found. */
  quote: string | null;
  /** Where the anchor is in `doc`, when found; section context is taken around it. */
  anchorOffset: number | null;
  /** Where the anchor ends; defaults to the start plus the quote's length. */
  anchorEnd?: number | null;
  imagePath: string | null;
}

export function buildAiRequest(inputs: RequestInputs, scope: ContextScope, image: PreparedImage | null): AiRequest {
  const offset = inputs.anchorOffset ?? 0;
  let context = null;
  if (scope === 'section' && inputs.anchorOffset !== null) context = sectionAround(inputs.doc, offset);
  if (scope === 'note') context = wholeNote(inputs.doc);
  return {
    noteName: inputs.noteName,
    quote: inputs.imagePath === null ? inputs.quote : null,
    image,
    context,
    messages: inputs.thread.messages.filter((m) => !m.deletedAt).map((m) => ({ author: m.author.name, origin: m.origin, body: m.body })),
  };
}

/**
 * Extra time for an agent request: a rewrite means the model writes the whole
 * target back, and a local model writes a few hundred characters a second at best.
 */
export function agentExtraSeconds(targetChars: number): number {
  return Math.ceil(targetChars / 1000) * 45;
}

export type AgentBuilt = { ok: true; request: AiRequest; region: Region } | { ok: false; message: string };

/**
 * An @Agent request: the text it may change (by scope) replaces the context
 * block, and the thread carries the instruction.
 */
export function buildAgentRequest(inputs: RequestInputs, scope: ContextScope): AgentBuilt {
  if (inputs.anchorOffset === null) return { ok: false, message: 'The passage could not be located in the note, so the agent has nothing to edit. Reattach it first.' };
  const end = inputs.anchorEnd ?? inputs.anchorOffset + (inputs.quote?.length ?? 0);
  const region = agentTarget(inputs.doc, inputs.anchorOffset, end, scope);
  if (region.text.length > MAX_CONTEXT_CHARS) {
    return { ok: false, message: `${region.label} is too long for the agent to edit (over ${MAX_CONTEXT_CHARS.toLocaleString('en-US')} characters). Choose a smaller scope.` };
  }
  return {
    ok: true,
    region,
    request: {
      noteName: inputs.noteName,
      quote: inputs.imagePath === null ? inputs.quote : null,
      image: null,
      context: null,
      target: { label: region.label, text: region.text },
      extraSeconds: agentExtraSeconds(region.text.length),
      messages: inputs.thread.messages.filter((m) => !m.deletedAt).map((m) => ({ author: m.author.name, origin: m.origin, body: m.body })),
    },
  };
}

/** The preview of an @Agent request: what it may change, per scope, and the exact text. */
export function agentPreview(inputs: RequestInputs, scope: ContextScope): AiPreviewData {
  const size = (candidate: ContextScope) => {
    const built = buildAgentRequest(inputs, candidate);
    return built.ok ? count([...AGENT_SYSTEM_PROMPT].length + [...buildPromptText(built.request)].length, 'character') : 'unavailable';
  };
  const built = buildAgentRequest(inputs, scope);
  const items = built.ok
    ? [
        `The text it may change: ${lower(built.region.label)} (${count([...built.region.text].length, 'character')})`,
        `${count(built.request.messages.length, 'message')} in this thread`,
        'Nothing in the note changes until you press Accept on its proposal.',
      ]
    : [built.message];
  return {
    items,
    scopes: [
      { scope: 'anchor', label: `Edit just this item or passage (${size('anchor')})` },
      { scope: 'section', label: `Edit its section (${size('section')})` },
      { scope: 'note', label: `Edit the whole note (${size('note')})` },
    ],
    exactText: built.ok ? `Instructions:\n${AGENT_SYSTEM_PROMPT}\n\nRequest:\n${buildPromptText(built.request)}` : built.message,
  };
}

export interface AiPreviewData {
  items: string[];
  scopes: { scope: ContextScope; label: string }[];
  exactText: string;
}

const count = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;

/** What the preview lists for the chosen scope. Image bytes are named here, not read. */
export function aiPreview(inputs: RequestInputs, scope: ContextScope): AiPreviewData {
  const imageName = inputs.imagePath?.split('/').pop() ?? null;
  const placeholder: PreparedImage | null = inputs.imagePath
    ? { path: inputs.imagePath, mediaType: 'image/png', data: '', bytes: 0 }
    : null;
  const request = buildAiRequest(inputs, scope, placeholder);
  const items: string[] = [];
  if (imageName) items.push(`The image ${imageName}`);
  else if (request.quote !== null) items.push(`The passage (${count([...request.quote].length, 'character')})`);
  items.push(`${count(request.messages.length, 'message')} in this thread`);
  if (request.context) items.push(`${request.context.label} (${count([...request.context.text].length, 'character')})`);

  const section = sectionAround(inputs.doc, inputs.anchorOffset ?? 0);
  const sectionLabel = inputs.anchorOffset === null ? 'Section unavailable — passage and thread only' : `Also ${lower(section.label)}`;
  const total = (candidate: ContextScope) => count([...SYSTEM_PROMPT].length + [...buildPromptText(buildAiRequest(inputs, candidate, placeholder))].length, 'character');
  let exactText = `Instructions:\n${SYSTEM_PROMPT}\n\nRequest:\n${buildPromptText(request)}`;
  if (imageName) exactText = `[Attached: the image file ${imageName}]\n\n${exactText}`;
  return {
    items,
    scopes: [
      { scope: 'anchor', label: `${imageName ? 'Just the image and the thread' : 'Just the passage and the thread'} (${total('anchor')})` },
      { scope: 'section', label: `${sectionLabel} (${total('section')})` },
      { scope: 'note', label: `Also the whole note (${total('note')})` },
    ],
    exactText,
  };
}

function lower(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}
