import * as vscode from 'vscode';
import { writeFile, rename, unlink } from 'fs/promises';
import * as path from 'path';
import { ChatMessage, ChatSession } from '../types';
import { ContextManager } from '../context/ContextManager'
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

const MAX_TRANSCRIPT_MESSAGE_CHARS = 2000;

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
    forceExport = false
  ): Promise<string | null> {

    // never export messages sent under privacy mode
    const shareable = session.messages.filter((m) => !m.private);
    if (shareable.length < 2) {
      return null;
    }

    const transcript = this._buildTranscript(shareable, session.username);

    // one llm call decides worth-saving and extracts metadata together
    const metadata = await this._extractMetadata(transcript, session.selectedModel);
    if (!metadata) {
      return null;
    }

    if (!forceExport && !metadata.worthSaving) {
      console.log('ContextSync: Quality gate rejected — conversation not technically useful yet.');
      return null;
    }

    metadata.tags = metadata.tags
      .map((t) => t.toLowerCase().trim().replace(/[^a-z0-9_\- ]/g, ''))
      .filter(Boolean);

    const relatedLinks = this._contextManager.findRelatedByTags(metadata.tags, session.id);

    const filename = `chat_${session.id}.md`;
    const filePath = path.join(syncFolder, filename);
    const content = this._buildMarkdown(session, metadata, relatedLinks);

    // write via temp file so the sync client never sees a partial file
    const tmpPath = `${filePath}.tmp`;
    try {
      await writeFile(tmpPath, content, 'utf-8');
      await rename(tmpPath, filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }

    return filePath;
  }

  private async _extractMetadata(transcript: string, preferredModelId?: string): Promise<SessionMetadata | null> {
    const response = await this._callLLM(
      `Extract from this dev conversation. JSON only, no markdown:\n` +
      `{"worthSaving":true if it contains technical decisions, code solutions, or architecture choices worth saving as team knowledge, else false,` +
      `"topic":"one sentence","tags":["2-6 lowercase tech tags"],"summary":"2-3 sentences","keyDecisions":["concrete decisions only"],"keyQuestions":["answered questions only"],"codeReferences":["file paths mentioned"]}\n\n` +
      `Conversation:\n${transcript}`,
      500,
      preferredModelId
    );

    try {
      const parsed = JSON.parse(response.replace(/```json|```/g, '').trim());
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
    if (typeof obj.topic !== 'string' || typeof obj.summary !== 'string') return null;

    // bound list sizes and entry lengths so llm output cannot bloat vault files
    const asStringArray = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 300)).slice(0, 12)
        : [];

    return {
      worthSaving: obj.worthSaving === true,
      topic: obj.topic.slice(0, 300),
      summary: obj.summary.slice(0, 1000),
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
      `tags: [${metadata.tags.join(', ')}]`,
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

  private _buildTranscript(messages: ChatMessage[], username: string): string {
    return messages
      .slice(-10)
      .map((m) => `${m.role === 'user' ? username : 'AI'}: ${m.content.slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS)}`)
      .join('\n\n');
  }

  private async _callLLM(prompt: string, maxTokens: number, preferredModelId?: string): Promise<string> {
    return completeWithModel(
      preferredModelId,
      [{ role: 'user', content: prompt }],
      { maxTokens },
      this._secrets
    );
  }
}
