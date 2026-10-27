import { readdir, readFile, lstat } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ContextFile } from '../types';
import { parseContextMarkdown, sanitiseField, tokenise } from './markdownParsing';
import { buildContextGraph, dijkstra, GraphPath, WeightedGraph } from './ContextGraph';

const LOAD_BATCH_SIZE = 50;
const MAX_FILE_SIZE_BYTES = 1024 * 1024;
const MIN_CONTEXT_RECORD_BYTES = Buffer.byteLength('{"source":"","tags":[],"topic":"","facts":[]}');
const folderKey = (folder: string): string => process.platform === 'win32' ? path.resolve(folder).toLowerCase() : path.resolve(folder);
const bounded = (value: unknown, fallback: number, minimum: number, maximum: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;

interface ContextCandidate {
  file: ContextFile;
  score: number;
  graphPath?: GraphPath;
}

export class ContextManager {
  private _files = new Map<string, ContextFile>();
  private _pendingLoad?: Map<string, ContextFile>;
  private _folder?: string;
  private _generation = 0;
  private _revisions = new Map<string, number>();
  private _tokenSets = new WeakMap<ContextFile, Set<string>>();
  private _graph?: WeightedGraph;

  get fileCount(): number { return this._files.size; }

  public clear(): void {
    this._generation++;
    this._folder = undefined;
    this._files.clear();
    this._pendingLoad = undefined;
    this._revisions.clear();
    this._graph = undefined;
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
      if (generation === this._generation) {
        this._files = next;
        this._graph = undefined;
      }
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
    this._graph = undefined;
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
    this._graph = undefined;
  }

  public buildContextBlock(query: string): string {
    const config = vscode.workspace.getConfiguration('contextSync');
    const maxFiles = Math.floor(bounded(config.get('maxContextFiles'), 5, 1, 50));
    const maxBytes = Math.floor(bounded(config.get('maxContextBytes'), 4096, 512, 65536));
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
    const lexical = scored.filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score || this._compareFiles(a.file, b.file));
    if (!lexical.length) return '';
    const { candidates, graphSlots } = this._hybridCandidates(lexical, maxFiles, config);
    const selected = new Set<string>();
    const lines: string[] = [];
    let graphCount = 0;
    let bytes = 0;
    let renderAttempts = 0;
    for (const candidate of candidates) {
      if (selected.size >= maxFiles) break;
      if (selected.has(candidate.file.filename) || (candidate.graphPath && graphCount >= graphSlots)) continue;
      const separator = lines.length ? 1 : 0;
      if (maxBytes - bytes - separator < MIN_CONTEXT_RECORD_BYTES || renderAttempts >= maxFiles * 10) break;
      renderAttempts++;
      const line = this._renderCandidate(candidate, querySet, maxBytes - bytes - separator);
      if (line === undefined) continue;
      lines.push(line);
      bytes += Buffer.byteLength(line, 'utf8') + separator;
      selected.add(candidate.file.filename);
      if (candidate.graphPath) graphCount++;
    }
    return lines.join('\n');
  }

  private _compareFiles(a: ContextFile, b: ContextFile): number {
    return b.modifiedAt.getTime() - a.modifiedAt.getTime() || (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
  }

  private _hybridCandidates(
    lexical: ContextCandidate[], maxFiles: number, config: vscode.WorkspaceConfiguration
  ): { candidates: ContextCandidate[]; graphSlots: number } {
    const graphSlots = Math.min(2, Math.floor(maxFiles / 2));
    const maxDistance = bounded(config.get('maxGraphDistance'), 4, 0, 10);
    if (config.get('retrievalMode') !== 'hybrid' || !graphSlots || !maxDistance) return { candidates: lexical, graphSlots: 0 };
    const graph = this._graph ?? (this._graph = buildContextGraph(this._files.values()));
    if (!graph.size) return { candidates: lexical, graphSlots: 0 };

    const seeds = lexical.slice(0, Math.min(3, maxFiles - graphSlots)).map(candidate => ({
      id: candidate.file.filename,
      distance: 1 - candidate.score / lexical[0].score,
    }));
    const maxVisited = Math.floor(bounded(config.get('maxGraphNodes'), 200, 1, 1000));
    const search = dijkstra(graph, seeds, {
      maxDistance,
      maxVisited,
      maxEdges: maxVisited * 20,
    });
    const scores = new Map(lexical.map(candidate => [candidate.file.filename, candidate.score]));
    const supporting: ContextCandidate[] = [];
    for (const [filename, graphPath] of search.paths) {
      const file = this._files.get(filename);
      if (file && graphPath.path.length > 1) supporting.push({ file, score: scores.get(filename) ?? 0, graphPath });
    }
    supporting.sort((a, b) => a.graphPath!.distance - b.graphPath!.distance || b.score - a.score || this._compareFiles(a.file, b.file));
    // Keep the strongest direct match first; linked notes have a small, explicit quota.
    return { candidates: [lexical[0], ...supporting, ...lexical.slice(1)], graphSlots };
  }

  private _renderCandidate(candidate: ContextCandidate, querySet: Set<string>, byteLimit: number): string | undefined {
    const file = candidate.file;
    const fields = [file.summary, ...file.keyDecisions].filter(Boolean);
    const relevant = fields.map((text, index) => ({ text, index, score: tokenise(text).filter(t => querySet.has(t)).length }))
      .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3);
    const record: { source: string; tags: string[]; topic: string; facts: string[]; via?: string[]; distance?: number } = {
      source: file.filename, tags: file.tags, topic: sanitiseField(file.topic, 120), facts: relevant.map(f => sanitiseField(f.text, 300)),
    };
    if (candidate.graphPath) {
      record.via = candidate.graphPath.path;
      record.distance = Math.round(candidate.graphPath.distance * 1000) / 1000;
    }
    let line = JSON.stringify(record);
    if (Buffer.byteLength(line, 'utf8') > byteLimit) { record.tags = []; line = JSON.stringify(record); }
    while (Buffer.byteLength(line, 'utf8') > byteLimit && record.facts.length > 1) {
      record.facts.pop();
      line = JSON.stringify(record);
    }
    // Drop whole records/passages rather than splitting JSON or technical facts.
    return Buffer.byteLength(line, 'utf8') <= byteLimit ? line : undefined;
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
