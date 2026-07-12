import { readdir, readFile, lstat } from 'fs/promises';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ContextFile } from '../types';
import { parseContextMarkdown, sanitiseField, tokenise } from './markdownParsing';

const LOAD_BATCH_SIZE = 50;
const MAX_FILE_SIZE_BYTES = 1024 * 1024; // context files are small; skip anything huge

export class ContextManager {
  private _files: Map<string, ContextFile> = new Map();
  private _pendingLoad?: Map<string, ContextFile>;

  get fileCount(): number {
    return this._files.size;
  }

  public async loadFromFolder(folderPath: string): Promise<void> {
    if (!existsSync(folderPath)) {
      vscode.window.showWarningMessage(
        `ContextSync: Sync folder not found: "${folderPath}". Check your contextSync.syncFolder setting.`
      );
      return;
    }

    // resolve path case-insensitively for windows
    const home = path.resolve(os.homedir());
    const resolved = path.resolve(folderPath);

    if (!resolved.toLowerCase().startsWith(home.toLowerCase() + path.sep)) {
      console.warn('ContextSync: Sync folder is outside your home directory. Double-check the path.');
    }

    let entries: string[];
    try {
      entries = (await readdir(folderPath)).filter((f) => f.endsWith('.md'));
    } catch {
      vscode.window.showWarningMessage(`ContextSync: Could not read sync folder: "${folderPath}".`);
      return;
    }

    if (entries.length === 0) {
      console.log('ContextSync: Sync folder exists but contains no .md files yet.');
    }

    // build into a new map so readers never see a partial cache
    const next = new Map<string, ContextFile>();
    this._pendingLoad = next;
    // batch reads to avoid exhausting file descriptors on large vaults
    for (let i = 0; i < entries.length; i += LOAD_BATCH_SIZE) {
      await Promise.all(
        entries.slice(i, i + LOAD_BATCH_SIZE).map(async (filename) => {
          const filePath = path.join(folderPath, filename);
          const parsed = await this._parseMarkdownFile(filePath, filename);
          if (parsed) next.set(filename, parsed);
        })
      );
    }
    this._files = next;
    if (this._pendingLoad === next) this._pendingLoad = undefined;
  }

  public async updateFile(filePath: string, filename: string): Promise<void> {
    const parsed = await this._parseMarkdownFile(filePath, filename);
    if (!parsed) return;
    this._files.set(filename, parsed);
    this._pendingLoad?.set(filename, parsed);
  }

  public removeFile(filename: string): void {
    this._files.delete(filename);
    this._pendingLoad?.delete(filename);
  }

  public buildContextBlock(query: string): string {
    if (this._files.size === 0) return '';

    const config = vscode.workspace.getConfiguration('contextSync');
    const maxFiles = Math.max(1, config.get<number>('maxContextFiles') ?? 5);
    const queryTokens = tokenise(query);

    const scored = [...this._files.values()].map((f) => {
      const fileTokens = new Set(f.tokens);
      const overlap = queryTokens.filter((t) => fileTokens.has(t)).length;
      return { file: f, score: overlap };
    });

    // drop zero score files unless nothing matches then fall back to recency
    const hasRelevant = scored.some((s) => s.score > 0);
    const candidates = hasRelevant ? scored.filter((s) => s.score > 0) : scored;

    // sort by relevance then recency
    const sorted = candidates
      .sort((a, b) =>
        b.score !== a.score
          ? b.score - a.score
          : b.file.modifiedAt.getTime() - a.file.modifiedAt.getTime()
      )
      .slice(0, maxFiles)
      .map((s) => s.file);

    return sorted.map((f) => {
      const decisions = f.keyDecisions.length
        ? ' | ' + f.keyDecisions.slice(0, 2).map((d) => sanitiseField(d, 120)).join('; ')
        : '';
      return `[${f.tags.join(',')}] ${sanitiseField(f.topic, 120)}${decisions}`;
    }).join('\n');
  }

  // rank cached files by tag overlap
  public findRelatedByTags(tags: string[], excludeSessionId: string): string[] {
    return [...this._files.values()]
      .filter((f) => !f.filename.includes(excludeSessionId))
      .map((f) => ({ f, score: f.tags.filter((t) => tags.includes(t)).length }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((r) => r.f.filename.replace('.md', ''));
  }

  public getLoadedFileNames(): string[] {
    return [...this._files.keys()];
  }

  private async _parseMarkdownFile(filePath: string, filename: string): Promise<ContextFile | null> {
    try {
      // reject symlinks so vault files cannot point at local files
      const stats = await lstat(filePath);
      if (!stats.isFile() || stats.size > MAX_FILE_SIZE_BYTES) return null;
      const raw = await readFile(filePath, 'utf-8');
      return parseContextMarkdown(raw, filename, stats.mtime);
    } catch {
      return null;
    }
  }
}