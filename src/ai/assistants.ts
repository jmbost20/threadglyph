import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliAdapter, claudeCandidates } from './claudeCli';
import { findTool, toolPath } from './cliEnv';
import { DEFAULT_GEMINI_MODEL, GeminiCliAdapter, type GeminiFiles } from './geminiCli';
import { nodeHttp } from './http';
import { nodeRunner } from './nodeRunner';
import { DEFAULT_OLLAMA_HOST, DEFAULT_OLLAMA_MODEL, OllamaAdapter } from './ollama';
import type { AiAdapter } from './types';

/** The assistants Threadglyph knows, in the owner's order of preference: on-device first. */
export const ASSISTANT_IDS = ['local', 'gemini', 'claude'] as const;
export type AssistantId = (typeof ASSISTANT_IDS)[number];

export interface AiSettings {
  aiEnabled: boolean;
  /** Which assistants are offered; each can be switched off on its own. */
  assistants: Record<AssistantId, boolean>;
  /** Preselected in the Ask AI preview when that assistant is on. */
  defaultAssistant: AssistantId;
  ollamaHost: string;
  ollamaModel: string;
  /** Blank: look in the usual install locations. */
  geminiPath: string;
  geminiModel: string;
  /** Blank: ~/.threadglyph/gemini. Holds the CLI's settings and the owner's `.gemini/.env` key file. */
  geminiFolder: string;
  /** Blank: look in the usual install locations. */
  claudePath: string;
  /** Blank: Claude Code's default model. */
  claudeModel: string;
  aiTimeoutSeconds: number;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  // AI is opt-in: human comments never need a model.
  aiEnabled: false,
  assistants: { local: true, gemini: true, claude: true },
  defaultAssistant: 'local',
  ollamaHost: DEFAULT_OLLAMA_HOST,
  ollamaModel: DEFAULT_OLLAMA_MODEL,
  geminiPath: '',
  geminiModel: DEFAULT_GEMINI_MODEL,
  geminiFolder: '',
  claudePath: '',
  claudeModel: '',
  // Local models on a laptop can take a while on a long passage.
  aiTimeoutSeconds: 180,
};

/**
 * Reads saved settings, filling gaps with defaults. Settings saved before
 * several assistants existed had one `aiModel`, which was Claude's.
 */
export function migrateAiSettings(saved: Record<string, unknown>): AiSettings {
  const legacyModel = typeof saved.aiModel === 'string' ? saved.aiModel : '';
  const assistants = { ...DEFAULT_AI_SETTINGS.assistants, ...(saved.assistants as Partial<AiSettings['assistants']> | undefined) };
  const merged = { ...DEFAULT_AI_SETTINGS, claudeModel: legacyModel, ...saved, assistants } as AiSettings & { aiModel?: unknown };
  delete merged.aiModel;
  if (!ASSISTANT_IDS.includes(merged.defaultAssistant)) merged.defaultAssistant = DEFAULT_AI_SETTINGS.defaultAssistant;
  return merged;
}

export function findClaude(configured: string, exists: (path: string) => boolean = existsSync): string {
  if (configured.trim()) return configured.trim();
  return claudeCandidates(homedir()).find(exists) ?? 'claude';
}

export const geminiFolderPath = (settings: Pick<AiSettings, 'geminiFolder'>, home = homedir()) =>
  settings.geminiFolder.trim().replace(/^~(?=\/|$)/, home) || ownGeminiFolder(home);

export const nodeGeminiFiles: GeminiFiles = {
  ensureDir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  async findKeyFile(folder) {
    for (const candidate of [join(folder, '.gemini', '.env'), join(folder, '.env')]) {
      if (await stat(candidate).then((s) => s.isFile(), () => false)) return candidate;
    }
    return null;
  },
  async makeRunHome(settings, keyFile) {
    const home = await mkdtemp(join(tmpdir(), 'threadglyph-gemini-'));
    await mkdir(join(home, '.gemini'), { mode: 0o700 });
    await writeFile(join(home, '.gemini', 'settings.json'), settings, { mode: 0o600 });
    // A link, so the key is never copied; Windows without developer mode can't link, so copy there.
    await symlink(keyFile, join(home, '.gemini', '.env')).catch(() => copyFile(keyFile, join(home, '.gemini', '.env')));
    return home;
  },
  async stageImage(bytes, extension) {
    const dir = await mkdtemp(join(tmpdir(), 'threadglyph-'));
    const file = join(dir, `image.${extension}`);
    await writeFile(file, bytes, { mode: 0o600 });
    return { dir, file };
  },
  removeDir: (dir) => rm(dir, { recursive: true, force: true }),
};

/** Threadglyph's own Gemini folder, where the key goes by default. */
export const ownGeminiFolder = (home = homedir()) => join(home, '.threadglyph', 'gemini');

/** The enabled assistants in preference order. Empty while AI is switched off. */
export function defaultAssistants(settings: AiSettings): AiAdapter[] {
  if (!settings.aiEnabled) return [];
  const home = homedir();
  const timeoutMs = Math.max(10, settings.aiTimeoutSeconds) * 1000;
  const inherited = process.env.PATH ?? '';
  const built: Record<AssistantId, () => AiAdapter> = {
    local: () => new OllamaAdapter({ host: settings.ollamaHost, model: settings.ollamaModel, timeoutMs, http: nodeHttp }),
    gemini: () => {
      const command = findTool('gemini', settings.geminiPath, home, existsSync);
      return new GeminiCliAdapter({
        command,
        folder: geminiFolderPath(settings, home),
        ownsFolder: !settings.geminiFolder.trim(),
        model: settings.geminiModel,
        timeoutMs,
        env: { PATH: toolPath(command, inherited, home) },
        run: nodeRunner,
        files: nodeGeminiFiles,
      });
    },
    claude: () => {
      const command = findClaude(settings.claudePath);
      return new ClaudeCliAdapter({
        command,
        // Outside the vault, so the CLI never picks up vault files or project instructions.
        cwd: tmpdir(),
        timeoutMs,
        model: settings.claudeModel,
        env: { PATH: toolPath(command, inherited, home) },
        run: nodeRunner,
      });
    },
  };
  return ASSISTANT_IDS.filter((id) => settings.assistants[id]).map((id) => built[id]());
}

/** The assistant a new Ask AI preview starts with: the configured default if it is on, else the first one on. */
export function preferredAssistant(assistants: AiAdapter[], preferred: string): AiAdapter | null {
  return assistants.find((a) => a.id === preferred) ?? assistants[0] ?? null;
}
