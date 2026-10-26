import * as vscode from 'vscode';
import { writeFile, rename, unlink, lstat, readFile } from 'fs/promises';
import { randomBytes, createHash } from 'crypto';
import * as path from 'path';
import { ChatMessage, ChatSession } from '../types';
import { ContextManager } from '../context/ContextManager'
import { truncateText, parseArray, parseContextMarkdown, parseFrontmatter } from '../context/markdownParsing';
import { completeWithModel } from '../llm/ModelRouter';

interface SessionMetadata {
  worthSaving: boolean;
  topic: string;
  tags: string[];
  summary: string;
  keyDecisions: string[];
  keyQuestions: string[];
  codeReferences: string[];
}


export class MarkdownExporter {

  private _contextManager: ContextManager;
  private _secrets: vscode.SecretStorage;

  constructor(contextManager: ContextManager, secrets: vscode.SecretStorage) {
    this._contextManager = contextManager;
    this._secrets = secrets;
  }

  public async exportSession(
    session: ChatSession,
    syncFolder: string,
    forceExport = false,
    background = false
  ): Promise<string | null> {

    // never export messages sent under privacy mode
    const shareable = session.messages.filter((m) => !m.private);
    if (shareable.length < 2) {
      return null;
    }

    if (!/^[A-Za-z0-9_-]{1,64}$/.test(session.id)) throw new Error('Invalid session ID.');
    const offset = session.exportedMessageCount ?? 0;
    const chunks = this._buildTranscripts(shareable.slice(offset), session.username);
    let lastPath: string | null = null;
    let rejected = false;
    for (const transcript of chunks) {
      // Content-addressed segments are immutable and retry-safe, including partial exports.
      const digest = createHash('sha256').update(transcript).digest('hex').slice(0, 20);
      const filePath = path.join(syncFolder, `chat_${session.id}_${digest}.md`);
      if (await this._hasValidSegment(filePath, session.id)) { lastPath = filePath; continue; }
      const metadata = await this._extractMetadata(transcript, session.selectedModel, background);
      if (!metadata) throw new Error('Model returned invalid export metadata. The conversation remains queued for retry.');
      if (!forceExport && !metadata.worthSaving) { rejected = true; continue; }
      metadata.tags = [...new Set(parseArray(metadata.tags.join(',')))];
      const content = this._buildMarkdown(session, metadata, this._contextManager.findRelatedByTags(metadata.tags, session.id));
      const tmpPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await writeFile(tmpPath, content, { encoding: 'utf-8', flag: 'wx' });
        await rename(tmpPath, filePath);
      } catch (err) {
        await unlink(tmpPath).catch(() => undefined);
        throw err;
      }
      lastPath = filePath;
    }
    // Partial success must not acknowledge and discard quality-rejected segments.
    return rejected ? null : lastPath;
  }

  private async _hasValidSegment(filePath: string, sessionId: string): Promise<boolean> {
    try {
      const stats = await lstat(filePath);
      if (!stats.isFile() || stats.size > 1024 * 1024) throw new Error(`Invalid existing export segment: ${filePath}`);
      const raw = (await readFile(filePath, 'utf-8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
      const frontmatter = raw.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
      const parsed = parseContextMarkdown(raw, path.basename(filePath), stats.mtime);
      if (!frontmatter || parseFrontmatter(frontmatter[1]).id !== sessionId || !parsed?.summary) {
        throw new Error(`Incomplete or corrupt export segment: ${filePath}. Repair or remove it before retrying.`);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async _extractMetadata(transcript: string, preferredModelId?: string, background = false): Promise<SessionMetadata | null> {
    const response = await this._callLLM(
      `Extract from this dev conversation. JSON only, no markdown:\n` +
      `{"worthSaving":true if it contains technical decisions, code solutions, or architecture choices worth saving as team knowledge, else false,` +
      `"topic":"one sentence","tags":["2-6 lowercase tech tags"],"summary":"2-3 sentences","keyDecisions":["concrete decisions only"],"keyQuestions":["answered questions only"],"codeReferences":["file paths mentioned"]}\n\n` +
      `Conversation:\n${transcript}`,
      500,
      preferredModelId,
      background
    );

    try {
      const parsed = JSON.parse(response.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim());
      return this._validateMetadata(parsed);
    } catch {
      console.error('ContextSync: Failed to parse metadata JSON');
      return null;
    }
  }

  // never trust llm output shape
  private _validateMetadata(parsed: unknown): SessionMetadata | null {
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.topic !== 'string' || !obj.topic.trim() || typeof obj.summary !== 'string' || !obj.summary.trim()) return null;

    // bound list sizes and entry lengths so llm output cannot bloat vault files
    const asStringArray = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string').map((x) => truncateText(x, 300)).slice(0, 12)
        : [];

    return {
      worthSaving: obj.worthSaving === true,
      topic: truncateText(obj.topic, 300),
      summary: truncateText(obj.summary, 1000),
      tags: asStringArray(obj.tags),
      keyDecisions: asStringArray(obj.keyDecisions),
      keyQuestions: asStringArray(obj.keyQuestions),
      codeReferences: asStringArray(obj.codeReferences),
    };
  }

  private _buildMarkdown(
    session: ChatSession,
    metadata: SessionMetadata,
    relatedLinks: string[]
  ): string {
    const lines = [
      '---',
      `id: ${session.id}`,
      `author: ${session.username}`,
      `topic: "${this._escapeYaml(metadata.topic)}"`,
      `tags: ${JSON.stringify(metadata.tags)}`,
      `created: ${session.startedAt}`,
      `updated: ${new Date().toISOString()}`,
      '---',
      '',
      '## Summary',
      this._flattenBodyField(metadata.summary),
      '',
    ];

    if (metadata.keyDecisions.length) {
      lines.push('## Key Decisions');
      metadata.keyDecisions.forEach((d) => lines.push(`- ${this._flattenBodyField(d)}`));
      lines.push('');
    }

    if (metadata.keyQuestions.length) {
      lines.push('## Key Questions');
      metadata.keyQuestions.forEach((q) => lines.push(`- ${this._flattenBodyField(q)}`));
      lines.push('');
    }

    if (metadata.codeReferences.length) {
      lines.push('## Code References');
      metadata.codeReferences.forEach((r) => lines.push(`- ${this._flattenBodyField(r)}`));
      lines.push('');
    }

    if (relatedLinks.length) {
      lines.push('## Related Conversations');
      relatedLinks.forEach((l) => lines.push(`- [[${l}]]`));
      lines.push('');
    }

    return lines.join('\n');
  }

  private _escapeYaml(text: string): string {
    return text
      .replace(/[\r\n]+/g, ' ')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
  }

  // keep llm output from breaking section parsing on reload
  private _flattenBodyField(text: string): string {
    return text
      .replace(/\s*\r?\n\s*/g, ' ')
      .replace(/^#+\s*/, '')
      .trim();
  }

  private _buildTranscripts(messages: ChatMessage[], username: string): string[] {
    const chunks: string[] = [];
    let chunk = '';
    let chunkBytes = 0;
    for (const message of messages) {
      const text = `${message.role === 'user' ? username : 'AI'}: ${message.content}\n\n`;
      for (const character of text) {
        const characterBytes = Buffer.byteLength(character);
        if (chunkBytes + characterBytes > 8000) {
          chunks.push(chunk);
          chunk = '';
          chunkBytes = 0;
        }
        chunk += character;
        chunkBytes += characterBytes;
      }
    }
    if (chunk.trim()) chunks.push(chunk);
    return chunks;
  }

  private async _callLLM(prompt: string, maxTokens: number, preferredModelId?: string, background = false): Promise<string> {
    return completeWithModel(
      preferredModelId,
      [{ role: 'user', content: prompt }],
      { maxTokens, background },
      this._secrets
    );
  }
}
