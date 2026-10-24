# Security policy

## Supported versions

Only the latest release gets fixes.

## Reporting a vulnerability

Please report it privately: through GitHub (**Security → Report a vulnerability** on this repository), or by email to **jmbost20@gmail.com** with "Threadglyph security" in the subject. Don't open a public issue. You should get a reply within a week.

Reports that matter most here:

- note text leaving the computer without the Ask AI preview, or going somewhere other than the destination it showed;
- note text written into tracked thread files (`threadglyph/threads/`);
- a way to make the plugin write to a note;
- a way to make the `gemini` or `claude` command-line tools run with tools, a shell, or files the plugin did not intend.

## How the plugin limits risk

- AI is off by default. Ask AI and @mention requests are previewed, with their destination and exact text, before they are sent.
- The destination is judged from where a request actually goes: an Ollama server on another machine is shown as leaving the computer.
- Both CLI assistants run as child processes without a shell, with the request on standard input. Claude Code runs with its tools, MCP servers and settings files off. Gemini CLI runs in read-only plan mode with extensions off, an MCP allow-list that names no real server (so none of yours start), and Threadglyph's tool exclusions in its own folder; your other user-level Gemini settings still apply. API keys are never read or stored by Threadglyph.
- Quoted passages are kept in `.threadglyph/`, which the README tells Git users to ignore. Comments and AI replies are stored in `threadglyph/threads/` and may quote or summarise notes, so treat them as personal data.
