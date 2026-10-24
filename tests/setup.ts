// DOM tests (happy-dom) get Obsidian's DOM helpers before any source module runs,
// as they would inside the app. Node-only tests have no DOM and skip this.
if (typeof HTMLElement !== 'undefined') await import('./obsidianStub');

export {};
