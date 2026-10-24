// DOM tests (happy-dom) get Obsidian's DOM helpers before any source module runs,
// as they would inside the app. Node-only tests have no DOM and skip this.
if (typeof HTMLElement !== 'undefined') await import('./obsidianStub');
// Electron (and so Obsidian) has window.confirm; happy-dom 21 no longer does. Tests spy on it.
if (typeof window !== 'undefined' && typeof window.confirm !== 'function') window.confirm = () => true;

export {};
