import { existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { ClaudeCliAdapter, claudeCandidates } from './claudeCli';
import { nodeRunner } from './nodeRunner';
import type { AiAdapter } from './types';

export interface AiSettings {
  aiEnabled: boolean;
  /** Blank: look in the usual install locations. */
  claudePath: string;
  /** Blank: Claude Code's default model. */
  aiModel: string;
  aiTimeoutSeconds: number;
}

export function findClaude(configured: string, exists: (path: string) => boolean = existsSync): string {
  if (configured.trim()) return configured.trim();
  return claudeCandidates(homedir()).find(exists) ?? 'claude';
}

/** The one adapter this stage ships: the local Claude Code CLI. Null while AI is switched off. */
export function defaultAdapter(settings: AiSettings): AiAdapter | null {
  if (!settings.aiEnabled) return null;
  return new ClaudeCliAdapter({
    command: findClaude(settings.claudePath),
    // Outside the vault, so the CLI never picks up vault files or project instructions.
    cwd: tmpdir(),
    timeoutMs: Math.max(10, settings.aiTimeoutSeconds) * 1000,
    model: settings.aiModel,
    run: nodeRunner,
  });
}
