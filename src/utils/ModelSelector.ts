
import * as vscode from 'vscode';
 
export async function selectCopilotModel(
  preferredModelId?: string
): Promise<vscode.LanguageModelChat[]> {
  try {
    // user choice
    if (preferredModelId) {
      const byId = await vscode.lm.selectChatModels({ id: preferredModelId });
      if (byId.length) return byId;
    }

    // preferred model family
    const byFamily = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
    if (byFamily.length) return byFamily;

    // any available model
    return await vscode.lm.selectChatModels({ vendor: 'copilot' });
  } catch {
    return [];
  }
}