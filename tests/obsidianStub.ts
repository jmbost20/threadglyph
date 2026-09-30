/**
 * Minimal stand-in for the parts of the Obsidian API the panel uses, so UI
 * behavior can be tested in happy-dom. Mirrors Obsidian's HTMLElement helpers.
 */

interface ElOptions {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
}

type Helpers = {
  createEl<K extends keyof HTMLElementTagNameMap>(tag: K, o?: ElOptions): HTMLElementTagNameMap[K];
  createDiv(o?: ElOptions): HTMLDivElement;
  createSpan(o?: ElOptions): HTMLSpanElement;
  empty(): void;
  setText(text: string): void;
  addClass(...cls: string[]): void;
  setAttr(name: string, value: string): void;
};

// The global HTMLElement typings for these helpers come from the real `obsidian` package.
const proto = HTMLElement.prototype as unknown as Helpers & HTMLElement;

proto.createEl = function (this: HTMLElement, tag: string, o: ElOptions = {}) {
  const el = document.createElement(tag);
  if (o.cls) el.className = o.cls;
  if (o.text !== undefined) el.textContent = o.text;
  for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, v);
  this.appendChild(el);
  return el;
} as Helpers['createEl'];
proto.createDiv = function (this: HTMLElement, o?: ElOptions) {
  return this.createEl('div', o);
};
proto.createSpan = function (this: HTMLElement, o?: ElOptions) {
  return this.createEl('span', o);
};
proto.empty = function (this: HTMLElement) {
  while (this.firstChild) this.removeChild(this.firstChild);
};
proto.setText = function (this: HTMLElement, text: string) {
  this.textContent = text;
};
proto.addClass = function (this: HTMLElement, ...cls: string[]) {
  this.classList.add(...cls);
};
proto.setAttr = function (this: HTMLElement, name: string, value: string) {
  this.setAttribute(name, value);
};

export class WorkspaceLeaf {}

export class ItemView {
  contentEl: HTMLElement;
  app = { scope: null as Scope | null };
  scope: Scope | null = null;
  constructor(public leaf: WorkspaceLeaf) {
    this.contentEl = document.createElement('div');
    document.body.appendChild(this.contentEl);
  }
}

/** Records hotkeys; tests fire them with `press`. */
export class Scope {
  keys: { modifiers: string[]; key: string; run: () => unknown }[] = [];
  constructor(public parent: Scope | null = null) {}
  register(modifiers: string[], key: string, run: () => unknown) {
    this.keys.push({ modifiers, key, run });
  }
  press(modifiers: string[], key: string) {
    return this.keys.find((k) => k.key === key && k.modifiers.join() === modifiers.join())?.run();
  }
}

export const openModals: Modal[] = [];
export class Modal {
  contentEl = document.createElement('div');
  titleEl = document.createElement('div');
  constructor(public app: unknown) {}
  open() {
    document.body.append(this.titleEl, this.contentEl);
    openModals.push(this);
    (this as unknown as { onOpen(): void }).onOpen();
  }
  close() {
    (this as unknown as { onClose(): void }).onClose();
    this.titleEl.remove();
    this.contentEl.remove();
    openModals.splice(openModals.indexOf(this), 1);
  }
}

/** Obsidian's @-style editor autocomplete; tests drive onTrigger and selectSuggestion directly. */
export class EditorSuggest<T> {
  context: { editor: FakeEditor; start: unknown; end: unknown; query: string } | null = null;
  closed = 0;
  constructor(public app: unknown) {}
  close() {
    this.closed++;
  }
  declare getSuggestions: (context: unknown) => T[];
}

export function setIcon(el: HTMLElement, icon: string): void {
  el.dataset.icon = icon;
}

// ── Fake runtime for plugin integration tests ─────────────────────────────────
// Just enough of Obsidian's App/Vault/Workspace/Editor surface for src/main.ts,
// backed by an in-memory file map with explicit event triggers.

type Listener = (...args: unknown[]) => unknown;

class Events {
  private listeners = new Map<string, Listener[]>();
  on(name: string, cb: Listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), cb]);
    return { name, cb };
  }
  trigger(name: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(name) ?? []) cb(...args);
  }
}

export class TAbstractFile {
  constructor(public path: string) {}
}

export class TFile extends TAbstractFile {
  get basename(): string {
    return this.path.split('/').pop()!.replace(/\.[^.]+$/, '');
  }
  get extension(): string {
    return this.path.split('.').pop() ?? '';
  }
}

export const notices: string[] = [];
export class Notice {
  constructor(message: string) {
    notices.push(message);
  }
}

/** Calls through immediately; the fake runtime has no need for timers. */
export function debounce<T extends unknown[]>(fn: (...args: T) => unknown) {
  const run = (...args: T) => void fn(...args);
  run.cancel = () => run;
  return run;
}

export class FakeAdapter {
  files = new Map<string, string>();
  dirs = new Set<string>();
  async exists(path: string) {
    return this.files.has(path) || this.dirs.has(path);
  }
  async read(path: string) {
    const data = this.files.get(path);
    if (data === undefined) throw new Error(`ENOENT ${path}`);
    return data;
  }
  async write(path: string, data: string) {
    this.files.set(path, data);
  }
  async mkdir(path: string) {
    this.dirs.add(path);
  }
  async list(dir: string) {
    const prefix = `${dir}/`;
    const files = [...this.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
    return { files, folders: [] as string[] };
  }
}

export class FakeVault extends Events {
  adapter = new FakeAdapter();
  getAbstractFileByPath(path: string) {
    return this.adapter.files.has(path) ? new TFile(path) : null;
  }
  async cachedRead(file: TFile) {
    return this.adapter.read(file.path);
  }
  /** Binary contents for image files; text files fall back to their UTF-8 bytes. */
  binaries = new Map<string, Uint8Array>();
  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const bytes = this.binaries.get(file.path) ?? new TextEncoder().encode(await this.adapter.read(file.path));
    return bytes.slice().buffer;
  }
  getMarkdownFiles() {
    return [...this.adapter.files.keys()].filter((p) => p.endsWith('.md')).sort().map((p) => new TFile(p));
  }
  getResourcePath(file: TFile) {
    return `app://local/${encodeURI(file.path)}`;
  }
}

/** Resolves a link by exact path, then by file name anywhere in the vault (like Obsidian's shortest-path links). */
export class FakeMetadataCache {
  constructor(private readonly vault: FakeVault) {}
  getFirstLinkpathDest(link: string) {
    const paths = [...this.vault.adapter.files.keys()];
    const name = (p: string) => p.split('/').pop();
    // Like Obsidian, a note link may leave out the .md extension.
    const hit = paths.find((p) => p === link) ?? paths.find((p) => name(p) === link) ?? paths.find((p) => name(p) === `${link}.md`);
    return hit ? new TFile(hit) : null;
  }
}

/** Offsets double as positions, which keeps selections easy to express. */
export class FakeEditor {
  selection: [number, number] = [0, 0];
  scrolled: unknown = null;
  cm: unknown = undefined;
  constructor(private readonly text: () => string) {}
  getValue() {
    return this.text();
  }
  somethingSelected() {
    return this.selection[0] !== this.selection[1];
  }
  getCursor(which: 'from' | 'to' = 'to') {
    return { offset: which === 'from' ? this.selection[0] : this.selection[1] };
  }
  posToOffset(pos: { offset: number }) {
    return pos.offset;
  }
  offsetToPos(offset: number) {
    return { offset };
  }
  setSelection(from: { offset: number }, to: { offset: number }) {
    this.selection = [from.offset, to.offset];
  }
  scrollIntoView(range: unknown) {
    this.scrolled = range;
  }
  /** Edits made through the editor, newest last; each is one undo step in Obsidian. */
  transactions: { from: number; to: number; text: string }[][] = [];
  /** Set by the fake workspace so edits land in the note's text. */
  write: (text: string) => void = () => {};
  transaction(tx: { changes: { from: { offset: number }; to?: { offset: number }; text: string }[] }) {
    const changes = tx.changes.map((c) => ({ from: c.from.offset, to: (c.to ?? c.from).offset, text: c.text }));
    let doc = this.getValue();
    for (const c of [...changes].sort((a, b) => b.from - a.from)) doc = doc.slice(0, c.from) + c.text + doc.slice(c.to);
    this.transactions.push(changes);
    this.write(doc);
  }
  replaceRange(text: string, from: { offset: number }, to?: { offset: number }) {
    this.transaction({ changes: [{ from, to, text }] });
  }
}

export class WorkspaceLeafImpl extends WorkspaceLeaf {
  view: unknown = null;
  constructor(private readonly workspace: FakeWorkspace) {
    super();
  }
  async setViewState(state: { type: string }) {
    this.view = this.workspace.createView(state.type, this);
    await (this.view as { onOpen?: () => Promise<void> }).onOpen?.();
  }
  async openFile(file: TFile) {
    this.view = new MarkdownView(this, file, this.workspace.vault);
    this.workspace.leaves.push(this);
  }
}

export class MarkdownView {
  editor: FakeEditor;
  mode: 'source' | 'preview' = 'source';
  previewMode = {
    rerenders: 0,
    rerender(this: { rerenders: number }) {
      this.rerenders++;
    },
  };
  getMode() {
    return this.mode;
  }
  constructor(
    public leaf: WorkspaceLeafImpl,
    public file: TFile | null,
    vault: FakeVault,
  ) {
    this.editor = new FakeEditor(() => (file ? (vault.adapter.files.get(file.path) ?? '') : ''));
    this.editor.write = (text) => {
      if (file) vault.adapter.files.set(file.path, text);
    };
  }
}

export class FakeWorkspace extends Events {
  leaves: WorkspaceLeafImpl[] = [];
  activeFile: TFile | null = null;
  activeLeaf: WorkspaceLeafImpl | null = null;
  factories = new Map<string, (leaf: WorkspaceLeafImpl) => unknown>();
  constructor(public vault: FakeVault) {
    super();
  }
  createView(type: string, leaf: WorkspaceLeafImpl) {
    return this.factories.get(type)!(leaf);
  }
  onLayoutReady(cb: () => void) {
    cb();
  }
  getLeavesOfType(type: string) {
    return this.leaves.filter((l) =>
      type === 'markdown' ? l.view instanceof MarkdownView : (l.view as { getViewType?: () => string })?.getViewType?.() === type,
    );
  }
  getRightLeaf() {
    const leaf = new WorkspaceLeafImpl(this);
    this.leaves.push(leaf);
    return leaf;
  }
  getLeaf() {
    return new WorkspaceLeafImpl(this);
  }
  async revealLeaf() {}
  getActiveFile() {
    return this.activeFile;
  }
  setActiveLeaf(leaf: WorkspaceLeafImpl) {
    this.activeLeaf = leaf;
  }
  /** Opens a note in a new markdown leaf and makes it active. */
  open(path: string): MarkdownView {
    const leaf = new WorkspaceLeafImpl(this);
    const view = new MarkdownView(leaf, new TFile(path), this.vault);
    leaf.view = view;
    this.leaves.push(leaf);
    this.activeFile = view.file;
    return view;
  }
}

export class FakeApp {
  scope = new Scope();
  vault = new FakeVault();
  workspace = new FakeWorkspace(this.vault);
  metadataCache = new FakeMetadataCache(this.vault);
}

export class Plugin {
  commands: { id: string; editorCheckCallback?: Listener; callback?: Listener }[] = [];
  extensions: unknown[] = [];
  postProcessors: Listener[] = [];
  settingTabs: PluginSettingTab[] = [];
  ribbon: Listener[] = [];
  data: unknown = null;
  constructor(public app: FakeApp) {}
  registerView(type: string, factory: (leaf: WorkspaceLeafImpl) => unknown) {
    this.app.workspace.factories.set(type, factory);
  }
  suggests: unknown[] = [];
  registerEditorSuggest(suggest: unknown) {
    this.suggests.push(suggest);
  }
  registerEditorExtension(ext: unknown) {
    this.extensions.push(ext);
  }
  registerMarkdownPostProcessor(processor: Listener) {
    this.postProcessors.push(processor);
  }
  addCommand(cmd: { id: string }) {
    this.commands.push(cmd);
  }
  registerEvent() {}
  addRibbonIcon(_icon: string, _title: string, cb: Listener) {
    this.ribbon.push(cb);
  }
  addSettingTab(tab: PluginSettingTab) {
    this.settingTabs.push(tab);
  }
  async loadData() {
    return this.data;
  }
  async saveData(data: unknown) {
    this.data = structuredClone(data);
  }
}

export class PluginSettingTab {
  containerEl = document.createElement('div');
  constructor(
    public app: unknown,
    public plugin: unknown,
  ) {}
}

export class Setting {
  constructor(private readonly el: HTMLElement) {}
  setName(name: string) {
    this.el.createDiv({ cls: 'setting-name', text: name });
    return this;
  }
  setDesc() {
    return this;
  }
  setHeading() {
    return this;
  }
  addToggle(build: (t: { setValue(v: boolean): unknown; onChange(cb: (v: boolean) => unknown): unknown }) => unknown) {
    const input = this.el.createEl('input', { attr: { type: 'checkbox' } });
    const api = {
      setValue: (v: boolean) => ((input.checked = v), api),
      onChange: (cb: (v: boolean) => unknown) => ((input.onchange = () => void cb(input.checked)), api),
    };
    build(api);
    return this;
  }
  addDropdown(
    build: (d: { addOption(value: string, label: string): unknown; setValue(v: string): unknown; onChange(cb: (v: string) => unknown): unknown }) => unknown,
  ) {
    const select = this.el.createEl('select');
    const api = {
      addOption: (value: string, label: string) => (select.createEl('option', { text: label, attr: { value } }), api),
      setValue: (v: string) => ((select.value = v), api),
      onChange: (cb: (v: string) => unknown) => ((select.onchange = () => void cb(select.value)), api),
    };
    build(api);
    return this;
  }
  addText(build: (t: { setValue(v: string): unknown; onChange(cb: (v: string) => unknown): unknown }) => unknown) {
    const input = this.el.createEl('input');
    const api = {
      setValue: (v: string) => ((input.value = v), api),
      onChange: (cb: (v: string) => unknown) => ((input.oninput = () => void cb(input.value)), api),
    };
    build(api);
    return this;
  }
}
