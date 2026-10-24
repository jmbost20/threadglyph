import js from '@eslint/js';
import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['main.js', 'coverage/**', 'node_modules/**', 'dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  // Obsidian's own review rules: the TypeScript ones for the plugin source only, and
  // its package.json checks. Scripts and tests keep the general rules above.
  ...obsidianmd.configs.recommended.flatMap((config) => {
    const files = JSON.stringify(config.files ?? null);
    if (files.includes('package.json')) return [config];
    if (config.files && !files.includes('ts')) return [];
    return [{ ...config, files: ['src/**/*.ts'] }];
  }),
  {
    files: ['src/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      'obsidianmd/ui/sentence-case': [
        'warn',
        {
          brands: ['Threadglyph', 'Obsidian', 'Ollama', 'Gemini', 'Gemini CLI', 'Claude', 'Claude Code', 'Agent Comments', 'Ask AI', 'Local', 'Google', 'Anthropic', 'Deleted comments'],
          acronyms: ['AI', 'CLI', 'API'],
          // Key hints such as "(⌘D)", "(E)" and "(Esc)" keep their key names, and
          // "e.g." / "vs." don't end a sentence.
          ignoreRegex: ['\\((⌘|⌥|⇧|E\\)|Esc\\))', '\\be\\.g\\.', '\\bvs\\.'],
        },
      ],
      // getSettingDefinitions() needs Obsidian 1.13; the plugin supports 1.7.2 and later.
      'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
    },
  },
  {
    // Node-side AI transport (child processes, HTTP). These timers never touch a window,
    // and the tests run them without one.
    files: ['src/ai/http.ts', 'src/ai/nodeRunner.ts'],
    rules: { 'obsidianmd/prefer-window-timers': 'off' },
  },
);
