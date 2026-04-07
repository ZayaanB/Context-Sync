import * as vscode from 'vscode';
import { ContextManager } from '../context/ContextManager';
import { ChatSession } from '../types';

export class ChatHandler {
  public readonly contextManager: ContextManager;

  constructor(contextManager: ContextManager) {
    this.contextManager = contextManager;
  }

  // ── Send a message and get a response ────────────────────────────────────

  public async sendMessage(session: ChatSession): Promise<string> {
    // Pick the best available Copilot model
    const models = await vscode.lm.selectChatModels({
      vendor: 'copilot',
      family: 'gpt-4o',
    });

    if (!models.length) {
      throw new Error(
        'No Copilot model available. Make sure GitHub Copilot is installed and signed in.'
      );
    }

    const model = models[0];
    const messages = this._buildMessages(session);
    const tokenSource = new vscode.CancellationTokenSource();

    const response = await model.sendRequest(messages, {}, tokenSource.token);

    // Collect streamed response
    let reply = '';
    for await (const chunk of response.text) {
      reply += chunk;
    }

    return reply;
  }

  // ── Build message array with context injected ─────────────────────────────

  private _buildMessages(session: ChatSession): vscode.LanguageModelChatMessage[] {
    const messages: vscode.LanguageModelChatMessage[] = [];

    // 1. System-level context from shared .md files
    const contextBlock = this.contextManager.buildContextBlock(
      session.messages.map((m) => m.content).join(' ')
    );

    if (contextBlock) {
      messages.push(
        vscode.LanguageModelChatMessage.User(
          `You are a helpful coding assistant. Your team shares context via the following notes. ` +
          `Use them as background knowledge when answering — do not mention them unless directly relevant.\n\n` +
          `--- TEAM CONTEXT ---\n${contextBlock}\n--- END CONTEXT ---`
        ),
        // Dummy assistant ack so model doesn't treat context as a question
        vscode.LanguageModelChatMessage.Assistant(
          'Understood. I have the team context loaded.'
        )
      );
    }

    // 2. Conversation history
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
