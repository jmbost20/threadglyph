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
 * Typing "@" in a note offers @agent. The note is only changed by the user's
 * own typing here; running the request is a separate command.
 */
export class AgentSuggest extends EditorSuggest<AgentSuggestion> {
  constructor(
    app: App,
    /** Null while AI is off, which hides the menu. */
    private readonly info: () => AgentSuggestion | null,
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
    context.editor.replaceRange('@agent ', context.start, context.end);
    this.close();
  }
}
