import { readdir, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ContextFile } from '../types';

export class ContextManager {
  private _files: Map<string, ContextFile> = new Map();

  get fileCount(): number {
    return this._files.size;
  }

  // load md files
  public async loadFromFolder(folderPath: string): Promise<void> {
    if (!existsSync(folderPath)) {
      vscode.window.showWarningMessage(
        `ContextSync: Sync folder not found: "${folderPath}". Check your contextSync.syncFolder setting.`
      );
      return;
    }

    // ensure valid file path (resolved + case-insensitive for windows)
    const home = path.resolve(os.homedir());
    const resolved = path.resolve(folderPath);

    if (!resolved.toLowerCase().startsWith(home.toLowerCase() + path.sep)) {
      vscode.window.showWarningMessage(
        'ContextSync: Sync folder is outside your home directory. Please double-check the path.'
      );
      return;
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

    this._files.clear();
    await Promise.all(
      entries.map(async (filename) => {
        const filePath = path.join(folderPath, filename);
        const parsed = await this._parseMarkdownFile(filePath, filename);
        if (parsed) this._files.set(filename, parsed);
      })
    );
  }

  // update files on change
  public async updateFile(filePath: string, filename: string): Promise<void> {
    const parsed = await this._parseMarkdownFile(filePath, filename);
    if (parsed) this._files.set(filename, parsed);
  }

  public removeFile(filename: string): void {
    this._files.delete(filename);
  }

  // inject context into prompt
  public buildContextBlock(query: string): string {
    if (this._files.size === 0) return '';

    const config = vscode.workspace.getConfiguration('contextSync');
    const maxFiles = config.get<number>('maxContextFiles') ?? 5;
    const queryTokens = this._tokenise(query);

    const scored = [...this._files.values()].map((f) => {
      const fileTokens = [...f.tags, ...this._tokenise(f.topic), ...this._tokenise(f.summary)];
      const overlap = queryTokens.filter((t) => fileTokens.includes(t)).length;
      return { file: f, score: overlap };
    });

    // sort context by relevance
    const sorted = scored
      .sort((a, b) =>
        b.score !== a.score
          ? b.score - a.score
          : b.file.modifiedAt.getTime() - a.file.modifiedAt.getTime()
      )
      .slice(0, maxFiles)
      .map((s) => s.file);

    return sorted.map((f) => {
      const decisions = f.keyDecisions.length
        ? ' | ' + f.keyDecisions.slice(0, 2).map((d) => this._sanitiseField(d, 120)).join('; ')
        : '';
      return `[${f.tags.join(',')}] ${this._sanitiseField(f.topic, 120)}${decisions}`;
    }).join('\n');
  }

  // query in-memory cache by tag overlap (used by MarkdownExporter)
  public findRelatedByTags(tags: string[], excludeSessionId: string): string[] {
    return [...this._files.values()]
      .filter((f) => !f.filename.includes(excludeSessionId))
      .map((f) => ({ f, score: f.tags.filter((t) => tags.includes(t)).length }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((r) => r.f.filename.replace('.md', ''));
  }

  // loaded files for UI
  public getLoadedFileNames(): string[] {
    return [...this._files.keys()];
  }

  // parse md into context file
  private async _parseMarkdownFile(filePath: string, filename: string): Promise<ContextFile | null> {
    try {
      const [raw, stats] = await Promise.all([readFile(filePath, 'utf-8'), stat(filePath)]);

      const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) return null;

      const fm = this._parseFrontmatter(frontmatterMatch[1]);
      const body = raw.slice(frontmatterMatch[0].length).trim();

      const summary = this._extractSection(body, 'Summary');
      const keyDecisions = this._extractList(body, 'Key Decisions');
      const links = this._extractWikilinks(body);

      return {
        filename,
        username: fm['author'] ?? 'unknown',
        topic: this._sanitiseField((fm['topic'] ?? '').replace(/^"|"$/g, ''), 120),
        tags: this._parseArray(fm['tags'] ?? ''),
        summary: this._sanitiseField(summary, 300),
        keyDecisions: keyDecisions.map((d) => this._sanitiseField(d, 120)),
        links,
        modifiedAt: stats.mtime,
      };
    } catch {
      return null;
    }
  }

  // strip prompt-injectable characters and cap length
  private _sanitiseField(text: string, maxLen: number): string {
    return text
      .replace(/[`<>{}[\]\\]/g, '')
      .replace(/\n+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .slice(0, maxLen)
      .trim();
  }

  // helpers
  private _parseFrontmatter(block: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return result;
  }

  private _parseArray(value: string): string[] {
    return value
      .replace(/[\[\]]/g, '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  private _extractSection(body: string, heading: string): string {
    const regex = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`);
    return body.match(regex)?.[1]?.trim() ?? '';
  }

  private _extractList(body: string, heading: string): string[] {
    return this._extractSection(body, heading)
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim());
  }

  private _extractWikilinks(body: string): string[] {
    return (body.match(/\[\[([^\]]+)\]\]/g) ?? []).map((m) => m.replace(/\[\[|\]\]/g, ''));
  }

  // filter out common words and punctuation
  private _tokenise(text: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to',
      'for', 'of', 'with', 'is', 'it', 'this', 'that', 'how', 'what',
      'should', 'we', 'i', 'my', 'do', 'be', 'use', 'can', 'are',
    ]);
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));
  }
}