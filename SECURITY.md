# Security policy

## Supported versions

Only the latest release gets fixes.

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue. You should get a reply within a week.

Reports that matter most here:

- note text leaving the computer without the Ask AI preview, or going somewhere other than the destination it showed;
- note text written into tracked thread files (`threadglyph/threads/`);
- a way to make the plugin change a note without Accept;
- a way to make the `gemini` or `claude` command-line tools run with tools, a shell, or files the plugin did not intend.

## How the plugin limits risk

- AI is off by default. Each request is previewed, with its destination, before it is sent.
- The Gemini and Claude assistants run as child processes without a shell, with the request on standard input and their tools, MCP servers and settings files turned off. API keys are never read or stored by Threadglyph.
- Quotes from notes are kept in `.threadglyph/`, which the README tells Git users to ignore.
