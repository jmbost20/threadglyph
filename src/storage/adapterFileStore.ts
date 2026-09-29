import type { DataAdapter } from 'obsidian';
import type { FileStore } from './threadStore';

/** FileStore over Obsidian's DataAdapter, which also reaches dot-folders the vault index skips. */
export class AdapterFileStore implements FileStore {
  constructor(private readonly adapter: DataAdapter) {}

  async read(path: string): Promise<string | null> {
    return (await this.adapter.exists(path)) ? this.adapter.read(path) : null;
  }

  write(path: string, data: string): Promise<void> {
    return this.adapter.write(path, data);
  }

  async list(dir: string): Promise<string[]> {
    return (await this.adapter.exists(dir)) ? (await this.adapter.list(dir)).files : [];
  }

  async ensureDir(dir: string): Promise<void> {
    let path = '';
    for (const part of dir.split('/')) {
      path = path ? `${path}/${part}` : part;
      if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
    }
  }
}
