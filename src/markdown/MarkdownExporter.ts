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

    // filter out irrelavant convos
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

    // normalize tags
    metadata.tags = metadata.tags.map((t) => t.toLowerCase().trim());

    const relatedLinks = this._findRelatedFiles(metadata.tags, syncFolder, session.id);

    const filename = `chat_${session.id}.md`;
    const filePath = path.join(syncFolder, filename);
    const content = this._buildMarkdown(session, metadata, relatedLinks);
    fs.writeFileSync(filePath, content, 'utf-8');

    return filePath;
  }

  // filter gate
  private async _qualityGate(transcript: string): Promise<boolean> {
    const response = await this._callLLM(
      `Does this conversation contain technical decisions, code solutions, or architecture choices worth saving as team knowledge? Answer only yes or no.\n\n${transcript}`,
      5
    );
    return response.toLowerCase().includes('yes');
  }

  // extract metadata
  private async _extractMetadata(transcript: string): Promise<{
    topic: string;
    tags: string[];
    summary: string;
    keyDecisions: string[];
    keyQuestions: string[];
    codeReferences: string[];
  } | null> {

    const response = await this._callLLM(
      `Extract from this dev conversation. JSON only, no markdown:\n` +
      `{"topic":"one sentence","tags":["2-6 lowercase tech tags"],"summary":"2-3 sentences","keyDecisions":["concrete decisions only"],"keyQuestions":["answered questions only"],"codeReferences":["file paths mentioned"]}\n\n` +
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

  // linking files based on tags
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
        try {
          const content = fs.readFileSync(path.join(syncFolder, filename), 'utf-8');
          const tagsMatch = content.match(/^tags:\s*\[([^\]]*)\]/m);
          if (!tagsMatch) return null;
          
          const fileTags = tagsMatch[1].split(',').map((t) => t.trim().toLowerCase());
          const sharedCount = tags.filter((t) => fileTags.includes(t)).length;
          return sharedCount > 0 ? { name: filename.replace('.md', ''), sharedCount } : null;
        } catch {
          return null;
        }
      })
      .filter((r): r is { name: string; sharedCount: number } => r !== null)
      .sort((a, b) => b.sharedCount - a.sharedCount)
      .slice(0, 3)
      .map((r) => r.name);
  }

  // build md file with structure
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
    const recent = session.messages.slice(-10);
    
    return recent
      .map((m) => `${m.role === 'user' ? session.username : 'AI'}: ${m.content}`)
      .join('\n\n');
  }

  private async _callLLM(prompt: string, maxTokens: number): Promise<string> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
    if (!models.length) throw new Error('No Copilot model available for export.');

    const tokenSource = new vscode.CancellationTokenSource();
    let response;
    try {
      response = await models[0].sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        tokenSource.token
      );
    } finally {
      tokenSource.dispose();
    }

    let result = '';
    for await (const chunk of response.text) result += chunk;
    return result;
  }
}
