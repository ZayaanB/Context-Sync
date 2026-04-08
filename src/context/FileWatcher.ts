import * as vscode from 'vscode';
import * as path from 'path';
import { ContextManager } from './ContextManager';

export class FileWatcher {
  private _contextManager: ContextManager;
  private _watcher?: vscode.FileSystemWatcher;
  private _onContextUpdated?: () => void;

  constructor(contextManager: ContextManager, onContextUpdated?: () => void) {
    this._contextManager = contextManager;
    this._onContextUpdated = onContextUpdated;
  }

  public start(folderPath: string): void {
    this.stop();

    // intial load of files
    this._contextManager.loadFromFolder(folderPath).then(() => {
      this._onContextUpdated?.();
    });

    // update watcher (look for md files)
    const pattern = new vscode.RelativePattern(folderPath, '*.md');
    this._watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this._watcher.onDidCreate((uri) => {
      this._contextManager.updateFile(uri.fsPath, path.basename(uri.fsPath));
      this._onContextUpdated?.();
    });

    this._watcher.onDidChange((uri) => {
      this._contextManager.updateFile(uri.fsPath, path.basename(uri.fsPath));
      this._onContextUpdated?.();
    });

    this._watcher.onDidDelete((uri) => {
      this._contextManager.removeFile(path.basename(uri.fsPath));
      this._onContextUpdated?.();
    });
  }

  public stop(): void {
    this._watcher?.dispose();
    this._watcher = undefined;
  }
}
