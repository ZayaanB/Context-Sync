// chat types
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ChatSession {
  id: string;
  username: string;
  messages: ChatMessage[];
  startedAt: string;
  topic?: string;
  tags?: string[];
}

// context types
export interface ContextFile {
  filename: string;
  username: string;
  topic: string;
  tags: string[];
  summary: string;
  keyDecisions: string[];
  links: string[];
  modifiedAt: Date;
  rawContent: string;
}

// websview messages
export type WebviewMessage =
  | { type: 'sendMessage'; content: string }
  | { type: 'newSession' }
  | { type: 'forceSave' }
  | { type: 'setPrivacy'; enabled: boolean }
  | { type: 'ready' };

// extension messages
export type ExtensionMessage =
  | { type: 'addMessage'; message: ChatMessage }
  | { type: 'setLoading'; loading: boolean }
  | { type: 'syncStatus'; status: string; fileCount: number; fileNames: string[] }
  | { type: 'qualityGateRejected' }
  | { type: 'sessionReset' }
  | { type: 'inactivityReset'; message: string }
  | { type: 'configWarning'; warnings: string[] }
  | { type: 'error'; message: string };
