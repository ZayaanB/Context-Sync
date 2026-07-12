import * as vscode from 'vscode';
import * as path from 'path';
import { ContextManager } from './ContextManager';

const NOTIFY_DEBOUNCE_MS = 500;

export class FileWatcher {
  private _contextManager: ContextManager;
  private _watcher?: vscode.FileSystemWatcher;
  private _onContextUpdated?: () => void;
  private _notifyTimer?: NodeJS.Timeout;

  constructor(contextManager: ContextManager, onContextUpdated?: () => void) {
    this._contextManager = contextManager;
    this._onContextUpdated = onContextUpdated;
  }

  // coalesce bursts of change events into one notification
  private _notify(): void {
    if (this._notifyTimer) clearTimeout(this._notifyTimer);
    this._notifyTimer = setTimeout(() => {
      this._notifyTimer = undefined;
      this._onContextUpdated?.();
    }, NOTIFY_DEBOUNCE_MS);
  }

  // await initial load before watching to avoid a race with clear
  public async start(folderPath: string): Promise<void> {
    this.stop();

    await this._contextManager.loadFromFolder(folderPath);
    this._onContextUpdated?.();

    // uri base is required to watch folders outside the workspace
    const pattern = new vscode.RelativePattern(vscode.Uri.file(folderPath), '*.md');
    this._watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this._watcher.onDidCreate((uri) => {
      this._contextManager
        .updateFile(uri.fsPath, path.basename(uri.fsPath))
        .then(() => this._notify())
        .catch((err) => console.error('ContextSync: updateFile error', err));
    });

    this._watcher.onDidChange((uri) => {
      this._contextManager
        .updateFile(uri.fsPath, path.basename(uri.fsPath))
        .then(() => this._notify())
        .catch((err) => console.error('ContextSync: updateFile error', err));
    });

    this._watcher.onDidDelete((uri) => {
      this._contextManager.removeFile(path.basename(uri.fsPath));
      this._notify();
    });
  }

  public stop(): void {
    if (this._notifyTimer) { clearTimeout(this._notifyTimer); this._notifyTimer = undefined; }
    this._watcher?.dispose();
    this._watcher = undefined;
  }
}