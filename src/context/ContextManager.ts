import * as fs from 'fs';
import * as path from 'path';
import { ContextFile } from '../types';

export class ContextManager {
  private _files: Map<string, ContextFile> = new Map();

  get fileCount(): number {
    return this._files.size;
  }

  // ── Load all .md files from the sync folder ───────────────────────────────

  public async loadFromFolder(folderPath: string): Promise<void> {
    if (!fs.existsSync(folderPath)) {
      throw new Error(`Sync folder not found: ${folderPath}`);
    }

    const entries = fs.readdirSync(folderPath).filter((f) => f.endsWith('.md'));
    this._files.clear();

    for (const filename of entries) {
      const filePath = path.join(folderPath, filename);
      const parsed = this._parseMarkdownFile(filePath, filename);
      if (parsed) {
        this._files.set(filename, parsed);
      }
    }
  }

  // ── Update a single file (called by FileWatcher) ──────────────────────────

  public updateFile(filePath: string, filename: string): void {
    const parsed = this._parseMarkdownFile(filePath, filename);
    if (parsed) {
      this._files.set(filename, parsed);
    }
  }

  public removeFile(filename: string): void {
    this._files.delete(filename);
  }

  // ── Build a context string to inject into a chat request ─────────────────
  //   Simple strategy: sort by recency, take top N files.
  //   Future: embed and rank by semantic similarity to the query.

  public buildContextBlock(query: string): string {
    if (this._files.size === 0) {
      return '';
    }

    const maxFiles = 5; // TODO: read from config
    const sorted = [...this._files.values()].sort(
      (a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime()
    );
    const top = sorted.slice(0, maxFiles);

    return top
      .map((f) => {
        const lines: string[] = [
          `### ${f.filename}`,
          `**Author:** ${f.username}  **Topic:** ${f.topic}`,
          `**Tags:** ${f.tags.join(', ')}`,
          '',
          `**Summary:** ${f.summary}`,
          '',
        ];

        if (f.keyDecisions.length) {
          lines.push('**Key Decisions:**');
          f.keyDecisions.forEach((d) => lines.push(`- ${d}`));
          lines.push('');
        }

        if (f.links.length) {
          lines.push(`**Related:** ${f.links.join(', ')}`);
        }

        return lines.join('\n');
      })
      .join('\n\n---\n\n');
  }

  // ── Parse a .md file into a ContextFile ───────────────────────────────────

  private _parseMarkdownFile(
    filePath: string,
    filename: string
  ): ContextFile | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const stats = fs.statSync(filePath);

      // Parse YAML frontmatter between --- delimiters
      const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) return null;

      const fm = this._parseFrontmatter(frontmatterMatch[1]);
      const body = raw.slice(frontmatterMatch[0].length).trim();

      // Extract sections from body
      const summary = this._extractSection(body, 'Summary');
      const keyDecisions = this._extractList(body, 'Key Decisions');
      const links = this._extractWikilinks(body);

      return {
        filename,
        username: fm['author'] ?? 'unknown',
        topic: fm['topic'] ?? '',
        tags: this._parseArray(fm['tags'] ?? ''),
        summary,
        keyDecisions,
        links,
        modifiedAt: stats.mtime,
        rawContent: raw,
      };
    } catch {
      return null;
    }
  }

  // ── Frontmatter helpers ───────────────────────────────────────────────────

  private _parseFrontmatter(block: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      result[key] = value;
    }
    return result;
  }

  private _parseArray(value: string): string[] {
    // Handles both "[a, b, c]" and "a, b, c"
    return value
      .replace(/[\[\]]/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private _extractSection(body: string, heading: string): string {
    const regex = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`);
    return body.match(regex)?.[1]?.trim() ?? '';
  }

  private _extractList(body: string, heading: string): string[] {
    const section = this._extractSection(body, heading);
    return section
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim());
  }

  private _extractWikilinks(body: string): string[] {
    const matches = body.match(/\[\[([^\]]+)\]\]/g) ?? [];
    return matches.map((m) => m.replace(/\[\[|\]\]/g, ''));
  }
}
