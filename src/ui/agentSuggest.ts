import {
  EditorSuggest,
  type App,
  type Editor,
  type EditorPosition,
  type EditorSuggestTriggerInfo,
} from 'obsidian';

export interface AgentSuggestion {
  label: string;
  detail: string;
}

/**
 * Typing "@a" in a note offers @agent. Choosing it removes the typed "@a…"
 * (so the note is as it was) and opens the window to ask the agent.
 */
export class AgentSuggest extends EditorSuggest<AgentSuggestion> {
  constructor(
    app: App,
    /** Null while AI is off, which hides the menu. */
    private readonly info: () => AgentSuggestion | null,
    /** Opens the ask window for this spot in the note. */
    private readonly onPick: (editor: Editor, at: EditorPosition) => void,
  ) {
    super(app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    if (!this.info()) return null;
    const offset = editor.posToOffset(cursor);
    const doc = editor.getValue();
    const before = doc.slice(doc.lastIndexOf('\n', offset - 1) + 1, offset);
    const typed = /(?:^|\s)@(\w*)$/.exec(before);
    // From "@a" on: a bare "@" stays with other plugins' menus (e.g. Inline Comments' members).
    if (!typed?.[1] || !'agent'.startsWith(typed[1].toLowerCase())) return null;
    return { start: editor.offsetToPos(offset - typed[1].length - 1), end: cursor, query: typed[1] };
  }

  getSuggestions(): AgentSuggestion[] {
    const info = this.info();
    return info ? [info] : [];
  }

  renderSuggestion(value: AgentSuggestion, el: HTMLElement): void {
    el.createDiv({ cls: 'tg-mention-option', text: value.label });
    el.createDiv({ cls: 'tg-mention-detail', text: value.detail });
  }

  selectSuggestion(): void {
    const context = this.context;
    if (!context) return;
    context.editor.replaceRange('', context.start, context.end);
    this.close();
    this.onPick(context.editor, context.start);
  }
}
