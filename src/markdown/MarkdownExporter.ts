import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChatSession } from '../types';

export class MarkdownExporter {

  public async exportSession(
    session: ChatSession,
    syncFolder: string,
    forceExport = false
  ): Promise<string | null> {

    if (session.messages.length < 2) {
      return null;
    }

    const transcript = this._buildTranscript(session);

    if (!forceExport) {
      const isWorthSaving = await this._qualityGate(transcript);
      if (!isWorthSaving) {
        console.log('ContextSync: Quality gate rejected — conversation not technically useful yet.');
        return null;
      }
    }

    const metadata = await this._extractMetadata(transcript);
    if (!metadata) {
      return null;
    }

    // Normalise tags to lowercase to prevent mismatches
    metadata.tags = metadata.tags.map((t) => t.toLowerCase().trim());

    const relatedLinks = this._findRelatedFiles(metadata.tags, syncFolder, session.id);

    const filename = `chat_${session.id}.md`;
    const filePath = path.join(syncFolder, filename);
    const content = this._buildMarkdown(session, metadata, relatedLinks);
    fs.writeFileSync(filePath, content, 'utf-8');

    return filePath;
  }

  // ── Quality gate ──────────────────────────────────────────────────────────

  private async _qualityGate(transcript: string): Promise<boolean> {
    const response = await this._callLLM(
      `You are a technical context filter for a software development team.\n` +
      `Review this conversation and answer only "yes" or "no":\n` +
      `Is this conversation technically useful enough to save as shared team context?\n` +
      `Save it if it contains decisions, solutions, code discussions, architecture choices, or debugging insights.\n` +
      `Do NOT save greetings, small talk, or vague questions with no resolution.\n\n` +
      `Conversation:\n${transcript}`,
      10
    );
    return response.toLowerCase().includes('yes');
  }

  // ── Metadata extraction ───────────────────────────────────────────────────

  private async _extractMetadata(transcript: string): Promise<{
    topic: string;
    tags: string[];
    summary: string;
    keyDecisions: string[];
    keyQuestions: string[];
    codeReferences: string[];
  } | null> {
    const response = await this._callLLM(
      `You are a technical knowledge extractor for a software development team.\n` +
      `Analyse this conversation and respond ONLY with a JSON object — no markdown, no explanation.\n\n` +
      `Required format:\n` +
      `{\n` +
      `  "topic": "one concise sentence describing what this conversation is about",\n` +
      `  "tags": ["tag1", "tag2"],\n` +
      `  "summary": "2-3 sentences capturing the outcome and key context",\n` +
      `  "keyDecisions": ["decision 1", "decision 2"],\n` +
      `  "keyQuestions": ["question that was asked and resolved"],\n` +
      `  "codeReferences": ["file paths or function names mentioned"]\n` +
      `}\n\n` +
      `Rules:\n` +
      `- tags: lowercase, technical, 2-6 tags (e.g. auth, jwt, refactor, typescript)\n` +
      `- keyDecisions: only concrete decisions made, not observations\n` +
      `- keyQuestions: only questions that were actually answered\n` +
      `- codeReferences: only if explicitly mentioned, otherwise empty array\n\n` +
      `Conversation:\n${transcript}`,
      500
    );

    try {
      return JSON.parse(response.replace(/```json|```/g, '').trim());
    } catch {
      console.error('ContextSync: Failed to parse metadata JSON', response);
      return null;
    }
  }

  // ── Tag-based related file linking ────────────────────────────────────────

  private _findRelatedFiles(
    tags: string[],
    syncFolder: string,
    currentSessionId: string
  ): string[] {
    if (!fs.existsSync(syncFolder)) return [];

    return fs
      .readdirSync(syncFolder)
      .filter((f) => f.endsWith('.md') && !f.includes(currentSessionId))
      .map((filename) => {
        const content = fs.readFileSync(path.join(syncFolder, filename), 'utf-8');
        const tagsMatch = content.match(/^tags:\s*\[([^\]]*)\]/m);
        if (!tagsMatch) return null;
        const fileTags = tagsMatch[1].split(',').map((t) => t.trim().toLowerCase());
        const sharedCount = tags.filter((t) => fileTags.includes(t)).length;
        return sharedCount > 0 ? { name: filename.replace('.md', ''), sharedCount } : null;
      })
      .filter((r): r is { name: string; sharedCount: number } => r !== null)
      .sort((a, b) => b.sharedCount - a.sharedCount)
      .slice(0, 3)
      .map((r) => r.name);
  }

  // ── Build .md file ────────────────────────────────────────────────────────

  private _buildMarkdown(
    session: ChatSession,
    metadata: {
      topic: string; tags: string[]; summary: string;
      keyDecisions: string[]; keyQuestions: string[]; codeReferences: string[];
    },
    relatedLinks: string[]
  ): string {
    const lines = [
      '---',
      `id: ${session.id}`,
      `author: ${session.username}`,
      `topic: "${metadata.topic}"`,
      `tags: [${metadata.tags.join(', ')}]`,
      `created: ${session.startedAt}`,
      `updated: ${new Date().toISOString()}`,
      '---',
      '',
      '## Summary',
      metadata.summary,
      '',
    ];

    if (metadata.keyDecisions.length) {
      lines.push('## Key Decisions');
      metadata.keyDecisions.forEach((d) => lines.push(`- ${d}`));
      lines.push('');
    }

    if (metadata.keyQuestions.length) {
      lines.push('## Key Questions');
      metadata.keyQuestions.forEach((q) => lines.push(`- ${q}`));
      lines.push('');
    }

    if (metadata.codeReferences.length) {
      lines.push('## Code References');
      metadata.codeReferences.forEach((r) => lines.push(`- ${r}`));
      lines.push('');
    }

    if (relatedLinks.length) {
      lines.push('## Related Conversations');
      relatedLinks.forEach((l) => lines.push(`- [[${l}]]`));
      lines.push('');
    }

    return lines.join('\n');
  }

  private _buildTranscript(session: ChatSession): string {
    return session.messages
      .map((m) => `${m.role === 'user' ? session.username : 'AI'}: ${m.content}`)
      .join('\n\n');
  }

  private async _callLLM(prompt: string, maxTokens: number): Promise<string> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
    if (!models.length) throw new Error('No Copilot model available for export.');

    const tokenSource = new vscode.CancellationTokenSource();
    const response = await models[0].sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      {},
      tokenSource.token
    );

    let result = '';
    for await (const chunk of response.text) result += chunk;
    return result;
  }
}
