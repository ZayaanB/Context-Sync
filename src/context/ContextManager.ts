import * as fs from 'fs';
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
    if (!fs.existsSync(folderPath)) {
      vscode.window.showWarningMessage(
        `ContextSync: Sync folder not found: "${folderPath}". Check your contextSync.syncFolder setting.`
      );
      return;
    }

    // ensure valid file path
    const home = os.homedir();
    if (!folderPath.startsWith(home)) {
      vscode.window.showWarningMessage(
        'ContextSync: Sync folder is outside your home directory. Please double-check the path.'
      );
      return;
    }

    const entries = fs.readdirSync(folderPath).filter((f) => f.endsWith('.md'));

    if (entries.length === 0) {
      console.log('ContextSync: Sync folder exists but contains no .md files yet.');
    }

    this._files.clear();
    for (const filename of entries) {
      const filePath = path.join(folderPath, filename);
      const parsed = this._parseMarkdownFile(filePath, filename);
      if (parsed) {
        this._files.set(filename, parsed);
      }
    }
  }

  // update files on change 
  public updateFile(filePath: string, filename: string): void {
    const parsed = this._parseMarkdownFile(filePath, filename);
    if (parsed) {
      this._files.set(filename, parsed);
    }
  }

  public removeFile(filename: string): void {
    this._files.delete(filename);
  }

  // inject context into prompt
  public buildContextBlock(query: string): string {
    if (this._files.size === 0) {
      return '';
    }

    const config = vscode.workspace.getConfiguration('contextSync');
    const maxFiles = config.get<number>('maxContextFiles') ?? 5;

    const queryTokens = this._tokenise(query);

    // Score each file by tag + topic overlap with the query
    const scored = [...this._files.values()].map((f) => {
      const fileTokens = [
        ...f.tags,
        ...this._tokenise(f.topic),
        ...this._tokenise(f.summary),
      ];
      const overlap = queryTokens.filter((t) => fileTokens.includes(t)).length;
      return { file: f, score: overlap };
    });

    // sort context by relavance (AI)
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
        ? ' | ' + f.keyDecisions.slice(0, 2).map(d => this._sanitiseForPrompt(d)).join('; ')
        : '';
      return `[${f.tags.join(',')}] ${this._sanitiseForPrompt(f.topic)}${decisions}`;
    }).join('\n');
  }

  // loaded files for UI
  public getLoadedFileNames(): string[] {
    return [...this._files.keys()];
  }

  // parse md into context file (AI)
  private _parseMarkdownFile(
    filePath: string,
    filename: string
  ): ContextFile | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const stats = fs.statSync(filePath);

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
        topic: fm['topic']?.replace(/^"|"$/g, '') ?? '',
        tags: this._parseArray(fm['tags'] ?? ''),
        summary,
        keyDecisions,
        links,
        modifiedAt: stats.mtime,
      };
    } catch {
      return null;
    }
  }

  private _sanitiseForPrompt(text: string): string {
    const injectionPatterns = [
      /ignore (all |previous )?instructions/i,
      /you are now/i,
      /disregard (the |your )?/i,
      /system prompt/i,
      /forget (all |previous |your )?/i,
      /new instructions/i,
    ];
    return text
      .split('\n')
      .filter(line => !injectionPatterns.some(p => p.test(line)))
      .join('\n');
  }

  // helpers (AI)
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
    return (body.match(/\[\[([^\]]+)\]\]/g) ?? []).map((m) =>
      m.replace(/\[\[|\]\]/g, '')
    );
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
