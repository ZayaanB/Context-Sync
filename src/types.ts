// ─── Chat Types ────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ChatSession {
  id: string;            // e.g. "alice_2025-01-15_001"
  username: string;
  messages: ChatMessage[];
  startedAt: string;
  topic?: string;        // Auto-generated after session ends
  tags?: string[];       // Auto-generated after session ends
}

// ─── Context Types ─────────────────────────────────────────────────────────

export interface ContextFile {
  filename: string;      // e.g. "chat_alice_2025-01-15_001.md"
  username: string;
  topic: string;
  tags: string[];
  summary: string;
  keyDecisions: string[];
  links: string[];       // Obsidian [[wikilinks]] to related files
  modifiedAt: Date;
  rawContent: string;
}

// ─── Webview Message Types ─────────────────────────────────────────────────

export type WebviewMessage =
  | { type: 'sendMessage'; content: string }
  | { type: 'ready' };

export type ExtensionMessage =
  | { type: 'addMessage'; message: ChatMessage }
  | { type: 'setLoading'; loading: boolean }
  | { type: 'syncStatus'; status: string; fileCount: number };
