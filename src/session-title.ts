import { ModelToolAgent } from "./model-provider.js";
import type { ConversationMessage } from "./model-provider.js";
import type { ChatAttachment, SecAgentConfig } from "./types.js";

export const OFFICIAL_TITLE_MODEL = "virtual-fast";
const TITLE_SYSTEM_PROMPT = "你是会话标题生成器。根据用户消息生成简洁、准确的会话标题。只输出标题本身，不要引号、前缀、解释、Markdown 或其他内容。标题使用用户消息的主要语言，长度不超过 30 个字符。";

function officialBaseUrl(): string | undefined {
  const apiUrl = (process.env.SECTL_OFFICIAL_API_URL || "").replace(/\/$/, "");
  if (!process.env.SECTL_OFFICIAL_TOKEN || !apiUrl) return undefined;
  return /\/v1$/i.test(apiUrl) ? apiUrl : `${apiUrl}/v1`;
}

function titleAgentConfig(config: SecAgentConfig, useOfficial: boolean): SecAgentConfig {
  const baseUrl = officialBaseUrl();
  const agent = useOfficial && baseUrl
    ? { ...config.agent, provider: "openai-responses" as const, model: OFFICIAL_TITLE_MODEL, apiKeyEnv: "SECTL_OFFICIAL_TOKEN", baseUrl, endpoint: "/responses", maxTokens: 64, systemPrompt: TITLE_SYSTEM_PROMPT }
    : { ...config.agent, maxTokens: 64, systemPrompt: TITLE_SYSTEM_PROMPT };
  return { ...config, agent };
}

function titlePrompt(content: string): string {
  return `请为下面这条用户消息生成会话标题。\n\n用户消息：\n${content.trim() || "（消息仅包含附件）"}`;
}

export function normalizeSessionTitle(raw: string): string {
  let title = raw.trim().replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```$/i, "").split(/\r?\n/, 1)[0].trim();
  title = title.replace(/^(?:标题|title)\s*[:：-]\s*/i, "").trim();
  if ((title.startsWith("\"") && title.endsWith("\"")) || (title.startsWith("“") && title.endsWith("”")) || (title.startsWith("'") && title.endsWith("'"))) title = title.slice(1, -1).trim();
  if (/^(?:模型响应为空|model response empty)$/i.test(title)) return "";
  return title.slice(0, 30).trim();
}

async function requestTitle(config: SecAgentConfig, content: string, attachments: ChatAttachment[], useOfficial: boolean, signal?: AbortSignal): Promise<string> {
  const agent = new ModelToolAgent(titleAgentConfig(config, useOfficial), [], undefined, undefined, false, true);
  const prompt = titlePrompt(content);
  const conversation: ConversationMessage[] = [{ role: "user", content: prompt, ...(attachments.length ? { attachments } : {}) }];
  const raw = await agent.run(prompt, [], async () => undefined, "none", conversation, signal);
  return normalizeSessionTitle(raw);
}

/** Generate a title without exposing title-model output in the normal runtime trace. */
export async function generateSessionTitle(config: SecAgentConfig, content: string, attachments: ChatAttachment[] = [], signal?: AbortSignal): Promise<string> {
  if (officialBaseUrl()) {
    try { return await requestTitle(config, content, attachments, true, signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      // A logged-in relay can temporarily lack the virtual alias; use the selected model as a fallback.
    }
  }
  return requestTitle(config, content, attachments, false, signal);
}
