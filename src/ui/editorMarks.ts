import { StateEffect, StateField, RangeSetBuilder, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, type DecorationSet } from '@codemirror/view';

export interface ThreadMark {
  /** Empty for the pending selection that is waiting for its first comment. */
  threadId: string;
  from: number;
  to: number;
  resolved: boolean;
  /** Label drawn in the badge after the passage; matches the panel card. */
  number?: number;
  focused?: boolean;
  pending?: boolean;
}

/** How a thread was opened from the editor; only explicit controls move focus into the panel. */
export type OpenSource = 'glyph' | 'badge' | 'text';

/** Replaces all Threadglyph marks in one editor. Dispatched by the plugin after each refresh. */
export const setThreadMarks = StateEffect.define<ThreadMark[]>();

const THREAD_ATTR = 'data-tg-thread';

class BadgeWidget extends WidgetType {
  constructor(
    private readonly mark: ThreadMark,
    private readonly onOpen: (threadId: string, source: OpenSource) => void,
  ) {
    super();
  }

  eq(other: BadgeWidget): boolean {
    const a = this.mark;
    const b = other.mark;
    return a.threadId === b.threadId && a.number === b.number && a.resolved === b.resolved && a.focused === b.focused;
  }

  toDOM(): HTMLElement {
    const el = createSpan();
    el.className = ['tg-badge', this.mark.resolved && 'tg-badge-resolved', this.mark.focused && 'tg-badge-focused']
      .filter(Boolean)
      .join(' ');
    el.textContent = String(this.mark.number);
    el.setAttribute(THREAD_ATTR, this.mark.threadId);
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `Open thread ${this.mark.number}`);
    // Keep the caret where it is: the badge is a control, not text.
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onOpen(this.mark.threadId, 'badge');
    });
    return el;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown' || event.type === 'click';
  }
}

function markClass(m: ThreadMark): string {
  if (m.pending) return 'tg-anchor tg-anchor-pending';
  const parts = ['tg-anchor'];
  if (m.resolved) parts.push('tg-anchor-resolved');
  if (m.focused) parts.push('tg-anchor-focused');
  return parts.join(' ');
}

function buildDecorations(
  marks: ThreadMark[],
  docLength: number,
  onOpen: (threadId: string, source: OpenSource) => void,
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const m of marks) {
    if (m.from < 0 || m.to > docLength || m.from >= m.to) continue;
    const attributes: Record<string, string> = m.pending ? {} : { [THREAD_ATTR]: m.threadId };
    ranges.push(Decoration.mark({ class: markClass(m), attributes }).range(m.from, m.to));
    if (!m.pending && m.number !== undefined) {
      ranges.push(Decoration.widget({ widget: new BadgeWidget(m, onOpen), side: 1 }).range(m.to));
    }
  }
  return Decoration.set(ranges, true);
}

function threadIdsOnLine(view: EditorView, field: StateField<DecorationSet>, lineFrom: number, lineTo: number) {
  const open: string[] = [];
  const resolved: string[] = [];
  view.state.field(field).between(lineFrom, lineTo, (from, _to, deco) => {
    if (from < lineFrom) return;
    const spec = deco.spec as { class?: string; attributes?: Record<string, string> };
    const id = spec.attributes?.[THREAD_ATTR];
    if (!id) return;
    (spec.class?.includes('tg-anchor-resolved') ? resolved : open).push(id);
  });
  return { open, resolved };
}

class GlyphMarker extends GutterMarker {
  constructor(
    private readonly count: number,
    private readonly resolvedOnly: boolean,
  ) {
    super();
  }

  eq(other: GlyphMarker): boolean {
    return other.count === this.count && other.resolvedOnly === this.resolvedOnly;
  }

  toDOM(): Node {
    const el = createSpan();
    el.className = this.resolvedOnly ? 'tg-glyph tg-glyph-resolved' : 'tg-glyph';
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', this.count === 1 ? 'Open thread' : `Open ${this.count} threads`);
    el.textContent = this.count > 1 ? String(this.count) : '';
    return el;
  }
}

export function threadMarksExtension(onOpen: (threadId: string, source: OpenSource) => void): Extension {
  /** Anchors map through edits between refreshes, so highlights never lag behind typing. */
  const marksField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(decorations, tr) {
      let next = decorations.map(tr.changes);
      for (const effect of tr.effects) {
        if (effect.is(setThreadMarks)) next = buildDecorations(effect.value, tr.state.doc.length, onOpen);
      }
      return next;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  return [
    marksField,
    EditorView.domEventHandlers({
      // Clicking highlighted text shows its thread but leaves the caret and focus in the note.
      click(event) {
        const target = event.target instanceof Element ? event.target.closest(`.tg-anchor[${THREAD_ATTR}]`) : null;
        const id = target?.getAttribute(THREAD_ATTR);
        if (id) onOpen(id, 'text');
        return false;
      },
    }),
    gutter({
      class: 'tg-gutter',
      markers(view) {
        const builder = new RangeSetBuilder<GutterMarker>();
        let lastLine = -1;
        view.state.field(marksField).between(0, view.state.doc.length, (from, _to, deco) => {
          if (!(deco.spec as { attributes?: Record<string, string> }).attributes?.[THREAD_ATTR]) return;
          const line = view.state.doc.lineAt(from);
          if (line.number === lastLine) return;
          lastLine = line.number;
          const ids = threadIdsOnLine(view, marksField, line.from, line.to);
          const count = ids.open.length + ids.resolved.length;
          if (count > 0) builder.add(line.from, line.from, new GlyphMarker(count, ids.open.length === 0));
        });
        return builder.finish();
      },
      domEventHandlers: {
        mousedown(view, block) {
          const ids = threadIdsOnLine(view, marksField, block.from, block.to);
          const target = ids.open[0] ?? ids.resolved[0];
          if (!target) return false;
          onOpen(target, 'glyph');
          return true;
        },
      },
    }),
  ];
}
