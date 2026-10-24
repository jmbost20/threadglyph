import { StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { extensionOf, findImageEmbeds, imageSupport, isRemote, type ImageEmbed } from '../anchor/imageEmbed';

/**
 * A small title line under each image with a Comment button, so an image can
 * be commented on with one click instead of placing the cursor on its embed.
 * The title is drawn by Threadglyph only; nothing is written into the note.
 */

export type CommentOnImage = (embed: ImageEmbed) => void;

/** Images that can be commented on: local files in a supported format. */
export function commentable(embed: ImageEmbed): boolean {
  return !isRemote(embed.link) && imageSupport(embed.link).ok;
}

export function titleElement(embed: ImageEmbed, onComment: CommentOnImage): HTMLElement {
  const el = createSpan();
  el.className = 'tg-image-title';
  el.setAttribute('contenteditable', 'false');
  const text = createSpan();
  text.className = 'tg-image-title-text';
  text.textContent = embed.title;
  const button = createEl('button');
  button.className = 'tg-image-comment';
  button.textContent = 'Comment';
  button.setAttribute('aria-label', `Comment on image ${embed.title}`);
  // Keep the caret where it is; the title is a control, not text.
  button.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onComment(embed);
  });
  el.append(text, button);
  return el;
}

class ImageTitleWidget extends WidgetType {
  constructor(
    private readonly embed: ImageEmbed,
    private readonly onComment: (view: EditorView, embed: ImageEmbed) => void,
  ) {
    super();
  }

  eq(other: ImageTitleWidget): boolean {
    const a = this.embed;
    const b = other.embed;
    return a.from === b.from && a.to === b.to && a.title === b.title;
  }

  toDOM(view: EditorView): HTMLElement {
    return titleElement(this.embed, (embed) => this.onComment(view, embed));
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function build(doc: string, onComment: (view: EditorView, embed: ImageEmbed) => void): DecorationSet {
  const ranges: Range<Decoration>[] = findImageEmbeds(doc)
    .filter(commentable)
    // side 2: after a thread badge (side 1) at the same position.
    .map((embed) => Decoration.widget({ widget: new ImageTitleWidget(embed, onComment), side: 2 }).range(embed.to));
  return Decoration.set(ranges, true);
}

/** Editor titles, recomputed only when the text changes. */
export function imageTitlesExtension(onComment: (view: EditorView, embed: ImageEmbed) => void): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => build(state.doc.toString(), onComment),
    update: (titles, tr) => (tr.docChanged ? build(tr.state.doc.toString(), onComment) : titles),
    provide: (field) => EditorView.decorations.from(field),
  });
}

const IMAGE_SRC = (src: string) => extensionOf(src.split('|')[0].split('#')[0].trim()) !== '';

/**
 * Reading view: pairs the section's wiki image embeds (in source order) with
 * the rendered `.internal-embed[src]` image elements (in DOM order). When the
 * counts differ the pairing would be a guess, so nothing is added.
 * `onComment` receives embeds with offsets in the whole note. Returns how many titles were added.
 */
export function titleRenderedImages(
  el: HTMLElement,
  source: string,
  sectionStart: number,
  sectionEnd: number,
  onComment: CommentOnImage,
): number {
  const embeds = findImageEmbeds(source.slice(sectionStart, sectionEnd)).filter((e) => e.wiki);
  const rendered = [...el.querySelectorAll<HTMLElement>('.internal-embed[src]')].filter((e) => IMAGE_SRC(e.getAttribute('src')!));
  if (!embeds.length || embeds.length !== rendered.length) return 0;
  let added = 0;
  embeds.forEach((local, i) => {
    const embed = { ...local, from: local.from + sectionStart, to: local.to + sectionStart };
    const target = rendered[i];
    if (!commentable(embed) || target.nextElementSibling?.classList.contains('tg-image-title')) return;
    // After the thread badge when there is one, so the number stays next to the image.
    const after = target.nextElementSibling?.classList.contains('tg-badge') ? target.nextElementSibling : target;
    after.after(titleElement(embed, onComment));
    added++;
  });
  return added;
}
