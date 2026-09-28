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
  addClass(cls: string): void;
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
proto.addClass = function (this: HTMLElement, cls: string) {
  this.classList.add(cls);
};
proto.setAttr = function (this: HTMLElement, name: string, value: string) {
  this.setAttribute(name, value);
};

export class WorkspaceLeaf {}

export class ItemView {
  contentEl: HTMLElement;
  constructor(public leaf: WorkspaceLeaf) {
    this.contentEl = document.createElement('div');
    document.body.appendChild(this.contentEl);
  }
}

export function setIcon(el: HTMLElement, icon: string): void {
  el.dataset.icon = icon;
}
