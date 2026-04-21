import * as vscode from 'vscode';
import { ContextManager } from '../context/ContextManager';
import { ChatSession, CopilotModel } from '../types';

export class ChatHandler {
  public readonly contextManager: ContextManager;

  constructor(contextManager: ContextManager) {
    this.contextManager = contextManager;
  }

  public async getAvailableModels(): Promise<CopilotModel[]> {
    try {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      return models.map((m) => ({
        id: m.id,
        name: m.name,
        vendor: m.vendor,
        family: m.family,
      }));
    } catch {
      return [];
    }
  }

  public async sendMessage(session: ChatSession): Promise<string> {
    let models: vscode.LanguageModelChat[] = [];
    const selectedModelId = session.selectedModel;

    try {
      if (selectedModelId) {
        models = await vscode.lm.selectChatModels({ id: selectedModelId });
      }
      if (!models.length) {
        models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      }
    } catch {
      // copilot unavailable — fall through to error below
    }

    if (!models.length) {
      throw new Error(
        'No Copilot model available. Make sure GitHub Copilot is installed and signed in, then try again.'
      );
    }

    const model = models[0];
    const messages = this._buildMessages(session);
    const tokenSource = new vscode.CancellationTokenSource();

    let response;
    try {
      response = await model.sendRequest(messages, {}, tokenSource.token);
    } catch (err: any) {
      // surface a clear message for common Copilot errors
      if (err?.code === 'NoPermissions') {
        throw new Error('Copilot returned a permissions error. Check your Copilot subscription is active.');
      }
      throw new Error(`Copilot request failed: ${err?.message ?? err}`);
    }

    let reply = '';
    for await (const chunk of response.text) {
      reply += chunk;
    }

    return reply;
  }

  // build message history with context
  private _buildMessages(session: ChatSession): vscode.LanguageModelChatMessage[] {
    const messages: vscode.LanguageModelChatMessage[] = [];

    const lastUserMessage = [...session.messages]
      .reverse()
      .find((m) => m.role === 'user')?.content ?? '';

    const contextBlock = this.contextManager.buildContextBlock(lastUserMessage);

    if (contextBlock) {
      messages.push(
        vscode.LanguageModelChatMessage.User(
          `You are a helpful coding assistant. Your team shares context via the following notes. ` +
          `Use them as background knowledge when answering — do not mention them unless directly relevant.\n\n` +
          `--- TEAM CONTEXT ---\n${contextBlock}\n--- END CONTEXT ---`
        ),
        vscode.LanguageModelChatMessage.Assistant(
          'Understood. I have the team context loaded.'
        )
      );
    }

    const isFirstExchange = session.messages.filter(m => m.role === 'user').length <= 1;
 
    if (contextBlock && isFirstExchange) {
      messages.push(
        vscode.LanguageModelChatMessage.User(
          `Team context (use only if relevant):\n${contextBlock}`
        ),
        vscode.LanguageModelChatMessage.Assistant('Understood.')
      );
    }

    for (const msg of session.messages) {
      if (msg.role === 'user') {
        messages.push(vscode.LanguageModelChatMessage.User(msg.content));
      } else {
        messages.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
      }
    }

    return messages;
  }
}
