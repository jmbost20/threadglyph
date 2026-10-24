# Roadmap

Where Threadglyph is heading, roughly in order. Nothing here has a date; it is a personal project maintained on a best-effort basis. Suggestions are welcome as [feature requests](https://github.com/jmbost20/threadglyph/issues/new/choose).

## Next

- **Obsidian community plugin directory.** Submit once the item below is done.
- **Obsidian-style confirmation dialogs** in place of the browser's `confirm()` for discarding unsaved text.

## Later

- **Mobile, without AI.** The plugin is desktop-only because the AI assistants need Node. Loading them only on desktop would let commenting work on phones and tablets.
- **Smarter reattach.** When the quoted text itself is edited, suggest the closest match instead of only marking the thread missing.
- **Export a note's threads to Markdown**, for a review summary or sharing.
- **Tests inside Obsidian in CI**, alongside the current unit and plugin tests.
- **Settings in Obsidian's settings search**, once the minimum supported Obsidian version reaches 1.13.

## Known limitations

- Gemini and Claude on Windows are unverified: npm installs them as `.cmd` launchers, which Node will not start without a shell, and Threadglyph never uses one. Local (Ollama) does not depend on this. Help checking is welcome ([#23](https://github.com/jmbost20/threadglyph/issues/23)).
- Desktop only. Sync carries thread messages but not anchors (they quote note text and stay local), so another device shows threads as needing a reattach.
- Anchors match exact text: editing the quoted words themselves detaches the thread.
- Reading view cannot highlight a quote that crosses a formatting boundary; the editor and panel still show it.
- Anchor files changed outside Obsidian are picked up on reload, because Obsidian does not watch dot-folders.
