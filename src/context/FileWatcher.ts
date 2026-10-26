import * as vscode from 'vscode';
import * as path from 'path';
import { ContextManager } from './ContextManager';

export class FileWatcher {
  private _watcher?: vscode.FileSystemWatcher;
  private _generation = 0;
  private _notifyTimer?: NodeJS.Timeout;
  private _changes = new Map<string, NodeJS.Timeout>();

  constructor(private readonly _contextManager: ContextManager, private readonly _onContextUpdated?: () => void) {}

  private _notify(): void {
    if (this._notifyTimer) clearTimeout(this._notifyTimer);
    this._notifyTimer = setTimeout(() => { this._notifyTimer = undefined; this._onContextUpdated?.(); }, 100);
  }

  public async start(folderPath: string): Promise<void> {
    this.stop();
    const generation = this._generation;
    // Watch before scanning. Buffer events until the scan is committed.
    let loading = true;
    const buffered = new Map<string, { uri: vscode.Uri; deleted: boolean }>();
    const apply = (uri: vscode.Uri, deleted: boolean) => {
      if (generation !== this._generation) return;
      if (loading) { buffered.set(uri.fsPath, { uri, deleted }); return; }
      const previous = this._changes.get(uri.fsPath);
      if (previous) clearTimeout(previous);
      this._changes.delete(uri.fsPath);
      if (deleted) {
        this._contextManager.removeFile(path.basename(uri.fsPath));
        this._notify();
      } else {
        this._changes.set(uri.fsPath, setTimeout(() => {
          this._changes.delete(uri.fsPath);
          if (generation !== this._generation) return;
          void this._contextManager.updateFile(uri.fsPath, path.basename(uri.fsPath)).then(() => {
            if (generation === this._generation) this._notify();
          }).catch(err => console.error('ContextSync: file update failed', err));
        }, 50));
      }
    };
    this._watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folderPath), '*.[mM][dD]'));
    this._watcher.onDidCreate(uri => apply(uri, false));
    this._watcher.onDidChange(uri => apply(uri, false));
    this._watcher.onDidDelete(uri => apply(uri, true));
    await this._contextManager.loadFromFolder(folderPath);
    if (generation !== this._generation) return;
    loading = false;
    for (const event of buffered.values()) apply(event.uri, event.deleted);
    this._onContextUpdated?.();
  }

  public stop(): void {
    this._generation++;
    if (this._notifyTimer) clearTimeout(this._notifyTimer);
    this._notifyTimer = undefined;
    for (const timer of this._changes.values()) clearTimeout(timer);
    this._changes.clear();
    this._watcher?.dispose();
    this._watcher = undefined;
  }
}
