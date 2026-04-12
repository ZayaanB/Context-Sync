import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChatHandler } from './ChatHandler';
import { ContextManager } from '../context/ContextManager';
import { ChatSession, WebviewMessage, CopilotModel } from '../types';
import { MarkdownExporter } from '../markdown/MarkdownExporter';

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _handler: ChatHandler;
  private readonly _exporter: MarkdownExporter;
  private _session: ChatSession;
  private _privacyMode: boolean = false;
  private _inactivityTimer?: NodeJS.Timeout;
  private _disposables: vscode.Disposable[] = [];

  // static chat panel
  public static createOrShow(extensionUri: vscode.Uri, contextManager: ContextManager) {
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
    if (ChatPanel.currentPanel) { ChatPanel.currentPanel._panel.reveal(column); return; }
    const panel = vscode.window.createWebviewPanel('contextSyncChat', 'ContextSync Chat', column, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'webview')],
      retainContextWhenHidden: true,
    });
    ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, contextManager);
  }

  public static notifyContextUpdated(contextManager: ContextManager) {
    if (!ChatPanel.currentPanel) return;
    ChatPanel.currentPanel._postMessage({
      type: 'syncStatus',
      status: 'Synced',
      fileCount: contextManager.fileCount,
      fileNames: contextManager.getLoadedFileNames(),
    });
  }

  // chat panel constructor
  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, contextManager: ContextManager) {
    this._panel = panel;
    this._handler = new ChatHandler(contextManager);
    this._exporter = new MarkdownExporter();
    this._session = this._createNewSession();
    this._panel.webview.html = this._getHtml(extensionUri);
    this._panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this._handleWebviewMessage(msg), null, this._disposables);
    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
  }

  // message handler
  private async _handleWebviewMessage(message: WebviewMessage) {
    if (message.type === 'sendMessage') { await this._handleUserMessage(message.content); }
    else if (message.type === 'newSession') { this._startNewSession(); }
    else if (message.type === 'forceSave') { await this._forceSave(); }
    else if (message.type === 'setPrivacy') { this._privacyMode = message.enabled; }
    else if (message.type === 'setModel') { this._session.selectedModel = message.modelId; }
    else if (message.type === 'requestModels') { await this._sendModelList(); }
    else if (message.type === 'ready') {
      this._postMessage({ type: 'syncStatus', status: 'Loaded', fileCount: this._handler.contextManager.fileCount, fileNames: this._handler.contextManager.getLoadedFileNames() });
      this._validateConfig();
      await this._sendModelList();
    }
  }

  private async _sendModelList() {
    const models = await this._handler.getAvailableModels();
    this._postMessage({ type: 'modelList', models });
  }

  private async _handleUserMessage(content: string) {
    const config = vscode.workspace.getConfiguration('contextSync');
    const syncFolder = config.get<string>('syncFolder') ?? '';
    this._resetInactivityTimer();
    const userMsg = { role: 'user' as const, content, timestamp: new Date().toISOString() };
    this._session.messages.push(userMsg);
    this._postMessage({ type: 'addMessage', message: userMsg });
    this._postMessage({ type: 'setLoading', loading: true });
    try {
      const reply = await this._handler.sendMessage(this._session);
      const assistantMsg = { role: 'assistant' as const, content: reply, timestamp: new Date().toISOString() };
      this._session.messages.push(assistantMsg);
      this._postMessage({ type: 'addMessage', message: assistantMsg });
      if (syncFolder && !this._privacyMode) {
        const filePath = await this._exporter.exportSession(this._session, syncFolder);
        if (filePath) {
          this._postMessage({ type: 'syncStatus', status: 'Saved', fileCount: this._handler.contextManager.fileCount, fileNames: this._handler.contextManager.getLoadedFileNames() });
        } else {
          this._postMessage({ type: 'qualityGateRejected' });
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(`ContextSync: ${err}`);
      this._postMessage({ type: 'error', message: String(err) });
    } finally {
      this._postMessage({ type: 'setLoading', loading: false });
    }
  }

  private _startNewSession() {
    this._session = this._createNewSession();
    this._postMessage({ type: 'sessionReset' });
  }

  private async _forceSave() {
    const syncFolder = vscode.workspace.getConfiguration('contextSync').get<string>('syncFolder') ?? '';
    if (!syncFolder) { this._postMessage({ type: 'error', message: 'No sync folder configured.' }); return; }
    if (this._session.messages.length < 2) { this._postMessage({ type: 'error', message: 'Nothing to save yet.' }); return; }
    const filePath = await this._exporter.exportSession(this._session, syncFolder, true);
    if (filePath) {
      this._postMessage({ type: 'syncStatus', status: 'Force saved', fileCount: this._handler.contextManager.fileCount, fileNames: this._handler.contextManager.getLoadedFileNames() });
    }
  }

  private _resetInactivityTimer() {
    if (this._inactivityTimer) clearTimeout(this._inactivityTimer);
    this._inactivityTimer = setTimeout(() => {
      this._startNewSession();
      this._postMessage({ type: 'inactivityReset', message: 'New session started after 30 minutes of inactivity.' });
    }, INACTIVITY_TIMEOUT_MS);
  }

  // validate config settings
  private _validateConfig() {
    const config = vscode.workspace.getConfiguration('contextSync');
    const warnings: string[] = [];
    if (!config.get<string>('username')) warnings.push('contextSync.username is not set.');
    if (!config.get<string>('syncFolder')) warnings.push('contextSync.syncFolder is not set.');
    if (warnings.length) this._postMessage({ type: 'configWarning', warnings });
  }

  // helpers (AI)
  private _postMessage(message: object) { this._panel.webview.postMessage(message); }

  private _createNewSession(): ChatSession {
    const config = vscode.workspace.getConfiguration('contextSync');
    const username = config.get<string>('username') || 'user';
    const date = new Date().toISOString().split('T')[0];
    return { id: `${username}_${date}_${Date.now()}`, username, messages: [], startedAt: new Date().toISOString() };
  }

  private _getHtml(extensionUri: vscode.Uri): string {
    const htmlPath = path.join(extensionUri.fsPath, 'src', 'webview', 'chat.html');
    return fs.readFileSync(htmlPath, 'utf-8');
  }

  private _dispose() {
    if (this._inactivityTimer) clearTimeout(this._inactivityTimer);
    ChatPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach((d) => d.dispose());
  }
}
