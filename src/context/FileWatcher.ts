import * as vscode from 'vscode';
import * as path from 'path';
import { ContextManager } from './ContextManager';

export class FileWatcher {
  private _contextManager: ContextManager;
  private _watcher?: vscode.FileSystemWatcher;

  constructor(contextManager: ContextManager) {
    this._contextManager = contextManager;
  }

  public start(folderPath: string): void {
    // Stop any existing watcher
    this.stop();

    // Do an initial full load
    this._contextManager.loadFromFolder(folderPath).catch(console.error);

    // Watch for .md changes inside the sync folder
    const pattern = new vscode.RelativePattern(folderPath, '*.md');
    this._watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this._watcher.onDidCreate((uri) => {
      const filename = path.basename(uri.fsPath);
      this._contextManager.updateFile(uri.fsPath, filename);
    });

    this._watcher.onDidChange((uri) => {
      const filename = path.basename(uri.fsPath);
      this._contextManager.updateFile(uri.fsPath, filename);
    });

    this._watcher.onDidDelete((uri) => {
      const filename = path.basename(uri.fsPath);
      this._contextManager.removeFile(filename);
    });
  }

  public stop(): void {
    this._watcher?.dispose();
    this._watcher = undefined;
  }
}
