import * as vscode from 'vscode';
import { ContextManager } from '../context/ContextManager';
import { ChatSession, CopilotModel } from '../types';
import { ChatTurn } from '../llm/types';
import { completeWithModel, listAllModels } from '../llm/ModelRouter';

const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_MESSAGE_CHARS = 4000;

export class ChatHandler {
  public readonly contextManager: ContextManager;
  private readonly _secrets: vscode.SecretStorage;

  constructor(contextManager: ContextManager, secrets: vscode.SecretStorage) {
    this.contextManager = contextManager;
    this._secrets = secrets;
  }

  public async getAvailableModels(): Promise<CopilotModel[]> {
    try {
      return await listAllModels(this._secrets);
    } catch {
      return [];
    }
  }

  public async sendMessage(session: ChatSession, token: vscode.CancellationToken): Promise<string> {
    const turns = this._buildTurns(session);
    return completeWithModel(session.selectedModel, turns, { token }, this._secrets);
  }

  // context is re-ranked on every turn
  private _buildTurns(session: ChatSession): ChatTurn[] {
    const messages: ChatTurn[] = [];

    const lastUserMessage = [...session.messages]
      .reverse()
      .find((m) => m.role === 'user')?.content ?? '';

    const contextBlock = this.contextManager.buildContextBlock(lastUserMessage);

    if (contextBlock) {
      messages.push(
        { role: 'user', content: `Team context (use only if relevant):\n${contextBlock}` },
        { role: 'assistant', content: 'Understood.' }
      );
    }

    // cap history count and truncate older messages to bound prompt size
    const recent = session.messages.slice(-MAX_HISTORY_MESSAGES);
    recent.forEach((msg, i) => {
      const isCurrentPrompt = i === recent.length - 1;
      const content = isCurrentPrompt ? msg.content : msg.content.slice(0, MAX_HISTORY_MESSAGE_CHARS);
      messages.push({ role: msg.role, content });
    });

    return messages;
  }
}