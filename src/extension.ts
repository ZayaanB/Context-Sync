import * as vscode from 'vscode';
import { ChatPanel, PENDING_SESSION_KEY } from './chat/ChatPanel';
import { ContextManager } from './context/ContextManager';
import { FileWatcher } from './context/FileWatcher';
import { MarkdownExporter } from './markdown/MarkdownExporter';
import { selectVsCodeModel } from './utils/ModelSelector';
import { ANTHROPIC_KEY_SECRET, OPENAI_KEY_SECRET } from './llm/ModelRouter';
import { ChatSession } from './types';

const MAX_PARTICIPANT_HISTORY_TURNS = 20;
const MAX_PARTICIPANT_TURN_CHARS = 4000;
const RECOVERY_DELAY_MS = 10 * 1000;

let fileWatcher: FileWatcher | undefined;

// validate shape and filename safe fields from persisted state
function isRecoverableSession(s: unknown): s is ChatSession {
  const obj = s as ChatSession;
  return (
    !!obj &&
    typeof obj === 'object' &&
    typeof obj.id === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(obj.id) &&
    typeof obj.username === 'string' &&
    /^[A-Za-z0-9_-]{1,32}$/.test(obj.username) &&
    typeof obj.startedAt === 'string' &&
    Array.isArray(obj.messages) &&
    obj.messages.every(
      (m) => !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
    )
  );
}

export function activate(context: vscode.ExtensionContext) {
  console.log('ContextSync is active');

  const contextManager = new ContextManager();

  fileWatcher = new FileWatcher(contextManager, () => {
    ChatPanel.notifyContextUpdated(contextManager);
  });

  const startWatcher = () => {
    const syncFolder = vscode.workspace
      .getConfiguration('contextSync')
      .get<string>('syncFolder');
    if (syncFolder) {
      fileWatcher?.start(syncFolder).catch((err) => console.error('ContextSync: watcher start failed', err));
    }
  };

  startWatcher();

  // export an interrupted session after a delay so a revived panel can reclaim it
  const recoveryTimer = setTimeout(() => {
    if (ChatPanel.currentPanel) return; // a live panel owns the session now
    const pendingSession = context.globalState.get<unknown>(PENDING_SESSION_KEY);
    if (!pendingSession) return;
    void context.globalState.update(PENDING_SESSION_KEY, undefined);
    if (!isRecoverableSession(pendingSession)) return;
    const pendingFolder = vscode.workspace.getConfiguration('contextSync').get<string>('syncFolder');
    if (pendingFolder) {
      new MarkdownExporter(contextManager, context.secrets)
        .exportSession(pendingSession, pendingFolder)
        .catch((err) => console.error('ContextSync: pending session export failed', err));
    }
  }, RECOVERY_DELAY_MS);
  context.subscriptions.push({ dispose: () => clearTimeout(recoveryTimer) });

  // restart watcher if config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('contextSync.syncFolder') ||
        e.affectsConfiguration('contextSync.username')
      ) {
        startWatcher();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('contextSync.openChat', () => {
      ChatPanel.createOrShow(context.extensionUri, contextManager, context.globalState, context.secrets);
    })
  );

  // api keys live in secret storage never in settings
  const registerKeyCommand = (command: string, secretKey: string, provider: string) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async () => {
        const key = await vscode.window.showInputBox({
          prompt: `${provider} API key (leave empty to clear the stored key)`,
          password: true,
          ignoreFocusOut: true,
        });
        if (key === undefined) return; // cancelled
        if (key.trim() === '') {
          await context.secrets.delete(secretKey);
          vscode.window.showInformationMessage(`ContextSync: ${provider} API key cleared.`);
        } else {
          await context.secrets.store(secretKey, key.trim());
          vscode.window.showInformationMessage(
            `ContextSync: ${provider} API key stored. Reopen the chat panel to see the new models.`
          );
        }
      })
    );
  };
  registerKeyCommand('contextSync.setAnthropicKey', ANTHROPIC_KEY_SECRET, 'Anthropic');
  registerKeyCommand('contextSync.setOpenAiKey', OPENAI_KEY_SECRET, 'OpenAI');

  // restore the chat panel after a window reload
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('contextSyncChat', {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        ChatPanel.revive(panel, context.extensionUri, contextManager, context.globalState, context.secrets);
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('contextSync.syncNow', async () => {
      const folder = vscode.workspace
        .getConfiguration('contextSync')
        .get<string>('syncFolder');

      if (!folder) {
        vscode.window.showErrorMessage(
          'ContextSync: No sync folder configured. Set contextSync.syncFolder in Settings.'
        );
        return;
      }

      await contextManager.loadFromFolder(folder);
      ChatPanel.notifyContextUpdated(contextManager);
      vscode.window.showInformationMessage(
        `ContextSync: Loaded ${contextManager.fileCount} context files.`
      );
    })
  );

  // read-only @contextsync chat participant
  const participant = vscode.chat.createChatParticipant(
    'contextsync.assistant',
    async (
      request: vscode.ChatRequest,
      chatContext: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ) => {
      const syncFolder = vscode.workspace
        .getConfiguration('contextSync')
        .get<string>('syncFolder');

      if (!syncFolder) {
        stream.markdown(
          '⚠️ No sync folder configured. Set `contextSync.syncFolder` in Settings to use ContextSync.'
        );
        return;
      }

      // context ranked by relevance to the query
      const contextBlock = contextManager.buildContextBlock(request.prompt);

      const models = await selectVsCodeModel();

      if (!models.length) {
        stream.markdown('No Copilot model available. Make sure GitHub Copilot is signed in.');
        return;
      }

      const model = models[0];

      const messages: vscode.LanguageModelChatMessage[] = [];

      if (contextBlock) {
        messages.push(
          vscode.LanguageModelChatMessage.User(
            `You are ContextSync, a helpful assistant with access to your team's shared knowledge base.\n` +
            `Use the following team context to inform your answer. ` +
            `Only reference it if it is directly relevant.\n\n` +
            `--- TEAM CONTEXT ---\n${contextBlock}\n--- END CONTEXT ---`
          ),
          vscode.LanguageModelChatMessage.Assistant(
            'Understood. I have the team context loaded and will use it where relevant.'
          )
        );
      } else {
        stream.markdown(
          `> ℹ️ No team context files found in your sync folder yet. ` +
          `Start a conversation in the ContextSync panel to build your context graph.\n\n`
        );
      }

      // replay prior turns capped in count and length
      for (const turn of chatContext.history.slice(-MAX_PARTICIPANT_HISTORY_TURNS)) {
        if (turn instanceof vscode.ChatRequestTurn) {
          messages.push(vscode.LanguageModelChatMessage.User(turn.prompt.slice(0, MAX_PARTICIPANT_TURN_CHARS)));
        } else if (turn instanceof vscode.ChatResponseTurn) {
          const text = turn.response
            .filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
            .map((part) => part.value.value)
            .join('');
          if (text) messages.push(vscode.LanguageModelChatMessage.Assistant(text.slice(0, MAX_PARTICIPANT_TURN_CHARS)));
        }
      }

      messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

      try {
        const response = await model.sendRequest(messages, {}, token);
        for await (const chunk of response.text) {
          stream.markdown(chunk);
        }
      } catch (err) {
        stream.markdown(
          `⚠️ Copilot request failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  // follow-up button opens the full panel
  participant.followupProvider = {
    provideFollowups(
      _result: vscode.ChatResult,
      _context: vscode.ChatContext,
      _token: vscode.CancellationToken
    ) {
      return [
        {
          prompt: '',
          label: '$(comment-discussion) Open ContextSync Panel',
          command: 'contextSync.openChat',
        },
      ];
    },
  };

  context.subscriptions.push(participant);
}

export function deactivate(): Promise<void> | undefined {
  fileWatcher?.stop();
  return ChatPanel.currentPanel?.flushPendingExport();
}