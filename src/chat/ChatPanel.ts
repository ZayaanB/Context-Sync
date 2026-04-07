import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChatHandler } from './ChatHandler';
import { ContextManager } from '../context/ContextManager';
import { ChatSession, WebviewMessage } from '../types';
import { MarkdownExporter } from '../markdown/MarkdownExporter';

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _handler: ChatHandler;
  private readonly _exporter: MarkdownExporter;
  private _session: ChatSession;
  private _disposables: vscode.Disposable[] = [];

  // ── Static factory ────────────────────────────────────────────────────────

  public static createOrShow(
    extensionUri: vscode.Uri,
    contextManager: ContextManager
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'contextSyncChat',
      'ContextSync Chat',
      column,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'webview')],
        retainContextWhenHidden: true,
      }
    );

    ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, contextManager);
  }

  // ── Constructor ───────────────────────────────────────────────────────────

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    contextManager: ContextManager
  ) {
    this._panel = panel;
    this._handler = new ChatHandler(contextManager);
    this._exporter = new MarkdownExporter();
    this._session = this._createNewSession();

    // Set the webview HTML
    this._panel.webview.html = this._getHtml(extensionUri);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this._handleWebviewMessage(message),
      null,
      this._disposables
    );

    // Clean up on close
    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
  }

  // ── Message handling ──────────────────────────────────────────────────────

  private async _handleWebviewMessage(message: WebviewMessage) {
    if (message.type === 'sendMessage') {
      await this._handleUserMessage(message.content);
    }
  }

  private async _handleUserMessage(content: string) {
    const config = vscode.workspace.getConfiguration('contextSync');
    const syncFolder = config.get<string>('syncFolder') ?? '';

    // Add user message to session
    const userMsg = {
      role: 'user' as const,
      content,
      timestamp: new Date().toISOString(),
    };
    this._session.messages.push(userMsg);
    this._postMessage({ type: 'addMessage', message: userMsg });
    this._postMessage({ type: 'setLoading', loading: true });

    try {
      // Get AI response with context injected
      const reply = await this._handler.sendMessage(this._session);

      const assistantMsg = {
        role: 'assistant' as const,
        content: reply,
        timestamp: new Date().toISOString(),
      };
      this._session.messages.push(assistantMsg);
      this._postMessage({ type: 'addMessage', message: assistantMsg });

      // Auto-export session to .md after each exchange
      if (syncFolder) {
        await this._exporter.exportSession(this._session, syncFolder);
        this._postMessage({
          type: 'syncStatus',
          status: 'Synced',
          fileCount: this._handler.contextManager.fileCount,
        });
      }
    } catch (err) {
      vscode.window.showErrorMessage(`ContextSync: ${err}`);
    } finally {
      this._postMessage({ type: 'setLoading', loading: false });
    }
  }


// ── Helpers ───────────────────────────────────────────────────────────────

private _postMessage(message: object) {
  this._panel.webview.postMessage(message);
}

private _createNewSession(): ChatSession {
  const config = vscode.workspace.getConfiguration('contextSync');
  const username = config.get<string>('username') || 'user';
  const date = new Date().toISOString().split('T')[0];
  const id = `${username}_${date}_${Date.now()}`;
  return {
    id,
    username,
    messages: [],
    startedAt: new Date().toISOString(),
  };
}

private _getHtml(extensionUri: vscode.Uri): string {
  const htmlPath = path.join(
    extensionUri.fsPath,
    'src',
    'webview',
    'chat.html'
  );
  return fs.readFileSync(htmlPath, 'utf-8');
}

private _dispose() {
  ChatPanel.currentPanel = undefined;
  this._panel.dispose();
  this._disposables.forEach((d) => d.dispose());
}
}
