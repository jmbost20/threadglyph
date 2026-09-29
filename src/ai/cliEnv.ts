/**
 * Obsidian started from the Dock inherits launchd's bare PATH (/usr/bin:/bin:…),
 * so command-line tools installed by npm or Homebrew are invisible to it. A
 * Node-based CLI such as Gemini also needs `node` on PATH for its
 * `#!/usr/bin/env node` line. These helpers find a tool by absolute path and
 * give it a PATH that includes the usual install folders.
 */

export function toolDirs(home: string): string[] {
  return [
    `${home}/.npm-global/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${home}/.local/bin`,
    `${home}/.volta/bin`,
    `${home}/.bun/bin`,
  ];
}

/**
 * The tool's own folder and the usual install folders first, then the inherited
 * PATH. Putting them first means a current Homebrew `node` wins over a stale one
 * left in an inherited folder.
 */
export function toolPath(binary: string, inherited: string, home: string): string {
  const own = binary.includes('/') ? [binary.slice(0, binary.lastIndexOf('/'))] : [];
  const seen = new Set<string>();
  return [...own, ...toolDirs(home), ...inherited.split(':')]
    .map((dir) => dir.trim())
    .filter((dir) => dir && !seen.has(dir) && seen.add(dir))
    .join(':');
}

/** The configured path when set, else the first install location that exists, else the bare name. */
export function findTool(
  name: string,
  configured: string,
  home: string,
  exists: (path: string) => boolean,
): string {
  if (configured.trim()) return configured.trim();
  return toolDirs(home)
    .map((dir) => `${dir}/${name}`)
    .find(exists) ?? name;
}
