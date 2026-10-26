import { readdir, readFile, lstat } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ContextFile } from '../types';
import { parseContextMarkdown, sanitiseField, tokenise } from './markdownParsing';

const LOAD_BATCH_SIZE = 50;
const MAX_FILE_SIZE_BYTES = 1024 * 1024;
const folderKey = (folder: string): string => process.platform === 'win32' ? path.resolve(folder).toLowerCase() : path.resolve(folder);

export class ContextManager {
  private _files = new Map<string, ContextFile>();
  private _pendingLoad?: Map<string, ContextFile>;
  private _folder?: string;
  private _generation = 0;
  private _revisions = new Map<string, number>();
  private _tokenSets = new WeakMap<ContextFile, Set<string>>();

  get fileCount(): number { return this._files.size; }

  public clear(): void {
    this._generation++;
    this._folder = undefined;
    this._files.clear();
    this._pendingLoad = undefined;
    this._revisions.clear();
  }

  public async loadFromFolder(folderPath: string): Promise<void> {
    const folder = path.resolve(folderPath);
    if (this._folder !== folderKey(folder)) this.clear();
    this._folder = folderKey(folder);
    const generation = ++this._generation;
    const scanRevisions = new Map(this._revisions);
    const next = new Map<string, ContextFile>();
    this._pendingLoad = next;
    try {
      const entries = (await readdir(folder)).filter(f => f.toLowerCase().endsWith('.md'));
      for (let i = 0; i < entries.length; i += LOAD_BATCH_SIZE) {
        if (generation !== this._generation) return;
        await Promise.all(entries.slice(i, i + LOAD_BATCH_SIZE).map(async filename => {
          const revision = scanRevisions.get(filename) ?? 0;
          const parsed = await this._parseMarkdownFile(path.join(folder, filename), filename);
          if (generation === this._generation && revision === (this._revisions.get(filename) ?? 0) && parsed) {
            next.set(filename, parsed);
          }
        }));
      }
      if (generation === this._generation) this._files = next;
    } catch {
      if (generation === this._generation) {
        vscode.window.showWarningMessage(`ContextSync: Could not read sync folder: "${folder}".`);
      }
    } finally {
      if (this._pendingLoad === next) this._pendingLoad = undefined;
    }
  }

  public async updateFile(filePath: string, filename: string): Promise<void> {
    if (folderKey(path.dirname(path.resolve(filePath))) !== this._folder) return;
    const generation = this._generation;
    const revision = (this._revisions.get(filename) ?? 0) + 1;
    this._revisions.set(filename, revision);
    const parsed = await this._parseMarkdownFile(filePath, filename);
    if (generation !== this._generation || revision !== this._revisions.get(filename)) return;
    if (parsed) {
      this._files.set(filename, parsed);
      this._pendingLoad?.set(filename, parsed);
    } else {
      this._files.delete(filename);
      this._pendingLoad?.delete(filename);
    }
  }

  public removeFile(filename: string): void {
    this._revisions.set(filename, (this._revisions.get(filename) ?? 0) + 1);
    this._files.delete(filename);
    this._pendingLoad?.delete(filename);
  }

  public buildContextBlock(query: string): string {
    const configured = vscode.workspace.getConfiguration('contextSync').get<number>('maxContextFiles');
    const maxFiles = Number.isFinite(configured) ? Math.max(1, Math.min(50, Math.floor(configured!))) : 5;
    const querySet = new Set(tokenise(query));
    const queryTokens = [...querySet];
    const scored = [...this._files.values()].map(file => {
      let tokens = this._tokenSets.get(file);
      if (!tokens) { tokens = new Set(file.tokens); this._tokenSets.set(file, tokens); }
      // Iterate the smaller vocabulary so large pasted prompts cannot multiply work per note.
      let score: number;
      if (queryTokens.length <= tokens.size) {
        score = queryTokens.reduce((overlap, token) => overlap + Number(tokens.has(token)), 0);
      } else {
        score = 0;
        for (const token of tokens) score += Number(querySet.has(token));
      }
      return { file, score };
    });
    // Unrelated recent notes should not consume the model's context budget.
    return scored.filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score || b.file.modifiedAt.getTime() - a.file.modifiedAt.getTime())
      .slice(0, maxFiles)
      .map(({ file }) => {
        const fields = [file.summary, ...file.keyDecisions].filter(Boolean);
        const relevant = fields.map((text, index) => ({ text, index, score: tokenise(text).filter(t => querySet.has(t)).length }))
          .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3);
        return JSON.stringify({ source: file.filename, tags: file.tags, topic: sanitiseField(file.topic, 120), facts: relevant.map(f => sanitiseField(f.text, 300)) });
      }).join('\n');
  }

  public findRelatedByTags(tags: string[], excludeSessionId: string): string[] {
    return [...this._files.values()].filter(f => !f.filename.startsWith(`chat_${excludeSessionId}`))
      .map(f => ({ f, score: new Set(f.tags.filter(t => tags.includes(t))).size }))
      .filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 3)
      .map(r => r.f.filename.replace(/\.md$/i, ''));
  }

  public getLoadedFileNames(): string[] { return [...this._files.keys()]; }

  private async _parseMarkdownFile(filePath: string, filename: string): Promise<ContextFile | null> {
    // Sync clients may briefly replace a file while a change event is being handled.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const stats = await lstat(filePath);
        if (!stats.isFile() || stats.size > MAX_FILE_SIZE_BYTES) return null;
        const raw = await readFile(filePath, 'utf-8');
        if (Buffer.byteLength(raw) > MAX_FILE_SIZE_BYTES) return null;
        const parsed = parseContextMarkdown(raw, filename, stats.mtime);
        if (parsed || attempt === 2) return parsed;
      } catch { if (attempt === 2) return null; }
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
    return null;
  }
}
