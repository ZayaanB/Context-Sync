
import * as vscode from 'vscode';
 
export async function selectVsCodeModel(
  preferredModelId?: string
): Promise<vscode.LanguageModelChat[]> {
  try {
    // user selected model first
    if (preferredModelId) {
      const byId = await vscode.lm.selectChatModels({ id: preferredModelId });
      if (byId.length) return byId;
    }

    // fall back to the default copilot family
    const byFamily = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
    if (byFamily.length) return byFamily;

    // then copilot then any provider
    const copilot = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (copilot.length) return copilot;

    return await vscode.lm.selectChatModels({});
  } catch {
    return [];
  }
}