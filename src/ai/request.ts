import type { PreparedImage } from '../anchor/imageEmbed';
import type { ThreadRecord } from '../model/types';
import { sectionAround, wholeNote } from './context';
import { buildPromptText } from './prompt';
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
  imagePath: string | null;
}

export function buildAiRequest(inputs: RequestInputs, scope: ContextScope, image: PreparedImage | null): AiRequest {
  const offset = inputs.anchorOffset ?? 0;
  let context = null;
  if (scope === 'section') context = sectionAround(inputs.doc, offset);
  if (scope === 'note') context = wholeNote(inputs.doc);
  return {
    noteName: inputs.noteName,
    quote: inputs.imagePath === null ? inputs.quote : null,
    image,
    context,
    messages: inputs.thread.messages.map((m) => ({ author: m.author.name, origin: m.origin, body: m.body })),
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
  else if (request.quote !== null) items.push(`The passage (${count(request.quote.length, 'character')})`);
  items.push(`${count(request.messages.length, 'message')} in this thread`);
  if (request.context) items.push(`${request.context.label} (${count(request.context.text.length, 'character')})`);

  const section = sectionAround(inputs.doc, inputs.anchorOffset ?? 0);
  const note = wholeNote(inputs.doc);
  let exactText = buildPromptText(request);
  if (imageName) exactText = `[Attached: the image file ${imageName}]\n\n${exactText}`;
  return {
    items,
    scopes: [
      { scope: 'anchor', label: imageName ? 'Just the image and the thread' : 'Just the passage and the thread' },
      { scope: 'section', label: `Also ${lower(section.label)} (${count(section.text.length, 'character')})` },
      { scope: 'note', label: `Also the whole note (${count(note.text.length, 'character')})` },
    ],
    exactText,
  };
}

function lower(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}
