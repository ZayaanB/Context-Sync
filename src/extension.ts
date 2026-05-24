import * as vscode from 'vscode';
import { ChatPanel } from './chat/ChatPanel';
import { ContextManager } from './context/ContextManager';
import { FileWatcher } from './context/FileWatcher';
import { selectCopilotModel } from './utils/ModelSelector';

let fileWatcher: FileWatcher | undefined;

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
      fileWatcher?.start(syncFolder);
    }
  };

  startWatcher();

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

  // open standalone chat panel
  context.subscriptions.push(
    vscode.commands.registerCommand('contextSync.openChat', () => {
      ChatPanel.createOrShow(context.extensionUri, contextManager);
    })
  );

  // manual sync
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

  // read-only method to use @contextsync in chat
  const participant = vscode.chat.createChatParticipant(
    'contextsync.assistant',
    async (
      request: vscode.ChatRequest,
      _context: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ) => {
      // check sync folder is configured
      const syncFolder = vscode.workspace
        .getConfiguration('contextSync')
        .get<string>('syncFolder');

      if (!syncFolder) {
        stream.markdown(
          '⚠️ No sync folder configured. Set `contextSync.syncFolder` in Settings to use ContextSync.'
        );
        return;
      }

      // build context block ranked by relevance to the query
      const contextBlock = contextManager.buildContextBlock(request.prompt);

      // model selection
      const models = await selectCopilotModel();

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
        // no context files loaded and inform user
        stream.markdown(
          `> ℹ️ No team context files found in your sync folder yet. ` +
          `Start a conversation in the ContextSync panel to build your context graph.\n\n`
        );
      }

      messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

      const response = await model.sendRequest(messages, {}, token);
      for await (const chunk of response.text) {
        stream.markdown(chunk);
      }
    }
  );

  // follow-up button to open the full panel
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

export function deactivate() {
  fileWatcher?.stop();
}