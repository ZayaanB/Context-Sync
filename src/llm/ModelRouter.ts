import * as vscode from 'vscode';
import { ChatTurn } from './types';
import { completeAnthropic, completeOpenAI } from './directClients';
import { selectVsCodeModel } from '../utils/ModelSelector';
import { CopilotModel } from '../types';

export const ANTHROPIC_PREFIX = 'anthropic:';
export const OPENAI_PREFIX = 'openai:';
export const ANTHROPIC_KEY_SECRET = 'contextSync.anthropicApiKey';
export const OPENAI_KEY_SECRET = 'contextSync.openaiApiKey';

const DEFAULT_CHAT_MAX_TOKENS = 4096;

export interface CompleteOptions {
  maxTokens?: number;
  token?: vscode.CancellationToken;
}

// list every vscode lm model plus direct api models when a key is stored
export async function listAllModels(secrets: vscode.SecretStorage): Promise<CopilotModel[]> {
  const models: CopilotModel[] = [];

  try {
    const lmModels = await vscode.lm.selectChatModels({});
    for (const m of lmModels) {
      models.push({ id: m.id, name: `${m.name} · ${m.vendor}`, vendor: m.vendor, family: m.family });
    }
  } catch {
    // direct api models may still be available
  }

  const config = vscode.workspace.getConfiguration('contextSync');

  if (await secrets.get(ANTHROPIC_KEY_SECRET)) {
    for (const m of config.get<string[]>('anthropicModels') ?? []) {
      if (typeof m === 'string' && m.trim()) {
        models.push({ id: `${ANTHROPIC_PREFIX}${m}`, name: `${m} · Anthropic API`, vendor: 'anthropic', family: m });
      }
    }
  }

  if (await secrets.get(OPENAI_KEY_SECRET)) {
    for (const m of config.get<string[]>('openaiModels') ?? []) {
      if (typeof m === 'string' && m.trim()) {
        models.push({ id: `${OPENAI_PREFIX}${m}`, name: `${m} · OpenAI API`, vendor: 'openai', family: m });
      }
    }
  }

  return models;
}

export async function completeWithModel(
  modelId: string | undefined,
  turns: ChatTurn[],
  opts: CompleteOptions,
  secrets: vscode.SecretStorage
): Promise<string> {
  const maxTokens = opts.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS;

  if (modelId?.startsWith(ANTHROPIC_PREFIX)) {
    const apiKey = await secrets.get(ANTHROPIC_KEY_SECRET);
    if (!apiKey) {
      throw new Error('No Anthropic API key stored. Run "ContextSync: Set Anthropic API Key".');
    }
    return completeAnthropic(apiKey, modelId.slice(ANTHROPIC_PREFIX.length), turns, maxTokens, opts.token);
  }

  if (modelId?.startsWith(OPENAI_PREFIX)) {
    const apiKey = await secrets.get(OPENAI_KEY_SECRET);
    if (!apiKey) {
      throw new Error('No OpenAI API key stored. Run "ContextSync: Set OpenAI API Key".');
    }
    return completeOpenAI(apiKey, modelId.slice(OPENAI_PREFIX.length), turns, maxTokens, opts.token);
  }

  return completeVsCodeLm(modelId, turns, opts);
}

async function completeVsCodeLm(
  modelId: string | undefined,
  turns: ChatTurn[],
  opts: CompleteOptions
): Promise<string> {
  const models = await selectVsCodeModel(modelId);
  if (!models.length) {
    throw new Error(
      'No language model available. Sign in to GitHub Copilot, or store an Anthropic/OpenAI API key via the ContextSync commands.'
    );
  }

  const messages = turns.map((t) =>
    t.role === 'user'
      ? vscode.LanguageModelChatMessage.User(t.content)
      : vscode.LanguageModelChatMessage.Assistant(t.content)
  );

  let response;
  try {
    response = await models[0].sendRequest(
      messages,
      opts.maxTokens ? { modelOptions: { max_tokens: opts.maxTokens } } : {},
      opts.token
    );
  } catch (err: any) {
    if (err instanceof vscode.CancellationError) {
      throw err;
    }
    if (err?.code === 'NoPermissions') {
      throw new Error('The language model returned a permissions error. Check your subscription is active.');
    }
    throw new Error(`Language model request failed: ${err?.message ?? err}`);
  }

  let reply = '';
  for await (const chunk of response.text) {
    reply += chunk;
  }
  return reply;
}
