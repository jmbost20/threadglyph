import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { DiffLine } from '../agent/diff';

/** A pending agent proposal drawn in the note: its text is dimmed and the change shows below it. */
export interface PreviewMark {
  key: string;
  from: number;
  to: number;
  diff: DiffLine[];
}

/** Replaces the proposal previews in one editor. Dispatched by the plugin after each refresh. */
export const setAgentPreviews = StateEffect.define<PreviewMark[]>();

export interface PreviewActions {
  accept(key: string): void;
  reject(key: string): void;
  /** Opens the original and proposed text side by side. */
  compare(key: string): void;
}

class ProposalWidget extends WidgetType {
  constructor(
    private readonly mark: PreviewMark,
    private readonly actions: PreviewActions,
  ) {
    super();
  }

  eq(other: ProposalWidget): boolean {
    return other.mark.key === this.mark.key && JSON.stringify(other.mark.diff) === JSON.stringify(this.mark.diff);
  }

  toDOM(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'tg-inline-proposal';
    box.dataset.proposal = this.mark.key;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Proposed change from the agent');
    // The proposed version; the original is right above, dimmed. New or changed lines are highlighted.
    const removed = this.mark.diff.filter((d) => d.kind === 'remove').length;
    const added = this.mark.diff.filter((d) => d.kind === 'add').length;
    const head = document.createElement('div');
    head.className = 'tg-inline-head';
    head.textContent = `Proposed version · ${removed} line${removed === 1 ? '' : 's'} removed, ${added} added`;
    box.appendChild(head);
    for (const line of this.mark.diff) {
      if (line.kind === 'remove') continue;
      const row = document.createElement('div');
      row.className = `tg-inline-line tg-inline-${line.kind}`;
      row.textContent = line.text || ' ';
      box.appendChild(row);
    }
    const buttons = document.createElement('div');
    buttons.className = 'tg-inline-buttons';
    const make = (text: string, cls: string, run: () => void) => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = text;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        run();
      });
      buttons.appendChild(b);
    };
    make('Compare', 'tg-button', () => this.actions.compare(this.mark.key));
    make('Reject', 'tg-button', () => this.actions.reject(this.mark.key));
    make('Accept', 'tg-button mod-cta', () => this.actions.accept(this.mark.key));
    box.appendChild(buttons);
    return box;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function build(marks: PreviewMark[], docLength: number, actions: PreviewActions): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const m of marks) {
    if (m.from < 0 || m.to > docLength || m.from > m.to) continue;
    if (m.from < m.to) ranges.push(Decoration.mark({ class: 'tg-agent-target' }).range(m.from, m.to));
    ranges.push(Decoration.widget({ widget: new ProposalWidget(m, actions), block: true, side: 1 }).range(m.to));
  }
  return Decoration.set(ranges, true);
}

export function agentPreviewExtension(actions: PreviewActions): Extension {
  // Block widgets must come from a state field, not a view plugin.
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(decorations, tr) {
      let next = decorations.map(tr.changes);
      for (const effect of tr.effects) {
        if (effect.is(setAgentPreviews)) next = build(effect.value, tr.state.doc.length, actions);
      }
      return next;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}
