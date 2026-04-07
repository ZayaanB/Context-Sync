import * as vscode from 'vscode';
import { ChatPanel } from './chat/ChatPanel';
import { ContextManager } from './context/ContextManager';
import { FileWatcher } from './context/FileWatcher';

let fileWatcher: FileWatcher | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('ContextSync is active');

  const contextManager = new ContextManager();
  fileWatcher = new FileWatcher(contextManager);

  // Start watching the sync folder if configured
  const syncFolder = vscode.workspace
    .getConfiguration('contextSync')
    .get<string>('syncFolder');

  if (syncFolder) {
    fileWatcher.start(syncFolder);
  }

  // Re-start watcher if config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('contextSync.syncFolder')) {
        const newFolder = vscode.workspace
          .getConfiguration('contextSync')
          .get<string>('syncFolder');
        if (newFolder) {
          fileWatcher?.start(newFolder);
        }
      }
    })
  );

  // Command: open chat panel
  context.subscriptions.push(
    vscode.commands.registerCommand('contextSync.openChat', () => {
      ChatPanel.createOrShow(context.extensionUri, contextManager);
    })
  );

  // Command: manual sync trigger
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
      vscode.window.showInformationMessage(
        `ContextSync: Loaded ${contextManager.fileCount} context files.`
      );
    })
  );
}

export function deactivate() {
  fileWatcher?.stop();
}
