import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from '@codemirror/view';

export interface ThreadMark {
  threadId: string;
  from: number;
  to: number;
  resolved: boolean;
}

/** Replaces all Threadglyph marks in one editor. Dispatched by the plugin after each refresh. */
export const setThreadMarks = StateEffect.define<ThreadMark[]>();

const THREAD_ATTR = 'data-tg-thread';

function buildDecorations(marks: ThreadMark[], docLength: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const valid = marks
    .filter((m) => m.from >= 0 && m.to <= docLength && m.from < m.to)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  for (const m of valid) {
    builder.add(
      m.from,
      m.to,
      Decoration.mark({
        class: m.resolved ? 'tg-anchor tg-anchor-resolved' : 'tg-anchor',
        attributes: { [THREAD_ATTR]: m.threadId },
      }),
    );
  }
  return builder.finish();
}

/** Anchors map through edits between refreshes, so highlights never lag behind typing. */
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setThreadMarks)) next = buildDecorations(effect.value, tr.state.doc.length);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function threadIdsOnLine(view: EditorView, lineFrom: number, lineTo: number): { open: string[]; resolved: string[] } {
  const open: string[] = [];
  const resolved: string[] = [];
  view.state.field(marksField).between(lineFrom, lineTo, (from, _to, deco) => {
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
    const el = document.createElement('span');
    el.className = this.resolvedOnly ? 'tg-glyph tg-glyph-resolved' : 'tg-glyph';
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', this.count === 1 ? 'Open thread' : `Open ${this.count} threads`);
    el.textContent = this.count > 1 ? String(this.count) : '';
    return el;
  }
}

export function threadMarksExtension(onOpen: (threadId: string) => void): Extension {
  return [
    marksField,
    gutter({
      class: 'tg-gutter',
      markers(view) {
        const builder = new RangeSetBuilder<GutterMarker>();
        let lastLine = -1;
        view.state.field(marksField).between(0, view.state.doc.length, (from) => {
          const line = view.state.doc.lineAt(from);
          if (line.number === lastLine) return;
          lastLine = line.number;
          const ids = threadIdsOnLine(view, line.from, line.to);
          const count = ids.open.length + ids.resolved.length;
          if (count > 0) builder.add(line.from, line.from, new GlyphMarker(count, ids.open.length === 0));
        });
        return builder.finish();
      },
      domEventHandlers: {
        mousedown(view, block) {
          const ids = threadIdsOnLine(view, block.from, block.to);
          const target = ids.open[0] ?? ids.resolved[0];
          if (!target) return false;
          onOpen(target);
          return true;
        },
      },
    }),
  ];
}
