import type { ChatAttachment, ReasoningEffort, SecAgentConfig } from "./types.js";

function isDeepSeekV4Model(modelName: string): boolean {
  return /^(?:deepseek-v4-flash|deepseek-v4-pro)(?:[-_].*)?$/i.test(modelName.trim());
}

function deepSeekReasoningEffort(effort: ReasoningEffort): "none" | "low" | "high" | "max" {
  if (effort === "none") return "none";
  if (effort === "low") return "low";
  if (effort === "max") return "max";
  return "high";
}

function isDoubaoModel(modelName: string): boolean {
  return /^(?:doubao|seed)[-_.]/i.test(modelName.trim());
}

/**
 * Volcengine Ark (Doubao) only accepts reasoning effort low/medium/high and
 * disables thinking via a top-level thinking.type=disabled field (it rejects
 * "none" and unknown reasoning sub-fields). Returns request fields to spread
 * into the Responses body; out-of-range efforts are clamped to supported levels.
 */
function doubaoReasoningFields(effort: ReasoningEffort): Record<string, unknown> {
  if (effort === "none") return { thinking: { type: "disabled" } };
  const level = effort === "minimal" || effort === "low" ? "low"
    : effort === "medium" ? "medium"
    : "high"; // high / xhigh / max
  return { reasoning: { effort: level, summary: "auto" } };
}
import type { RegisteredMcpTool } from "./mcp-adapter.js";
import type { LoadedSkill } from "./skills.js";

type ExecuteTool = (key: string, args: Record<string, unknown>) => Promise<unknown>;
export type AgentTool = Pick<RegisteredMcpTool, "key" | "description" | "inputSchema">;
export interface ConversationMessage { role: "user" | "assistant"; content: string; attachments?: ChatAttachment[] }
type ModelTrace = (stage: string, data: unknown) => void;

// Tool execution is intentionally unbounded. The model may need more than a fixed
// number of discovery/read/write turns for complex external applications.

function dataUrlParts(attachment: ChatAttachment): { mediaType: string; data: string } {
  const match = attachment.dataUrl.match(/^data:([^;,]+);base64,(.*)$/s);
  return { mediaType: match?.[1] || attachment.mimeType, data: match?.[2] || attachment.dataUrl };
}

function openAIContent(message: ConversationMessage): string | Array<Record<string, unknown>> {
  if (!message.attachments?.length) return message.content;
  return [
    ...(message.content ? [{ type: "text", text: message.content }] : []),
    ...message.attachments.map((attachment) => ({ type: "image_url", image_url: { url: attachment.dataUrl } }))
  ];
}

function responsesContent(message: ConversationMessage): string | Array<Record<string, unknown>> {
  if (!message.attachments?.length) return message.content;
  return [
    ...(message.content ? [{ type: "input_text", text: message.content }] : []),
    ...message.attachments.map((attachment) => ({ type: "input_image", image_url: attachment.dataUrl }))
  ];
}

function toGoogleSchema(input: unknown): Record<string, unknown> {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const rawType = source.type;
  const typeValue = Array.isArray(rawType) ? rawType.find((item) => item !== "null") : rawType;
  const schema: Record<string, unknown> = {};
  if (typeof typeValue === "string") schema.type = typeValue.toUpperCase();
  else if (source.properties && typeof source.properties === "object") schema.type = "OBJECT";
  else if (source.items) schema.type = "ARRAY";
  if (Array.isArray(rawType) && rawType.includes("null")) schema.nullable = true;
  if (typeof source.description === "string") schema.description = source.description;
  if (Array.isArray(source.enum)) schema.enum = source.enum;
  if (source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)) {
    schema.properties = Object.fromEntries(Object.entries(source.properties as Record<string, unknown>).map(([key, value]) => [key, toGoogleSchema(value)]));
  }
  if (Array.isArray(source.required)) schema.required = source.required.filter((item): item is string => typeof item === "string");
  if (source.items) schema.items = toGoogleSchema(source.items);
  return schema;
}

export class ModelToolAgent {
  private agent: SecAgentConfig["agent"];
  constructor(config: SecAgentConfig, _skills: LoadedSkill[], private trace?: ModelTrace) {
    const skillCatalog = _skills.length
      ? `\n\n## 可用 Skills\n${_skills.map((skill) => `- ${skill.name}: ${skill.description}（入口文件：${skill.relativePath || skill.path}）`).join("\n")}`
      : "";
    this.agent = { ...config.agent, systemPrompt: `${config.agent.systemPrompt}${skillCatalog}` };
  }
  async run(instruction: string, tools: AgentTool[], execute: ExecuteTool, reasoningEffort: ReasoningEffort = "high", conversation?: ConversationMessage[]): Promise<string> {
    if (!tools.length) throw new Error("没有已启用且可发现的 MCP 工具");
    const key = process.env[this.agent.apiKeyEnv];
    if (!key) throw new Error(`未配置模型密钥环境变量 ${this.agent.apiKeyEnv}。请设置后重试；密钥不要写入 secagent.yaml。`);
    if (this.agent.provider === "anthropic") return this.runAnthropic(instruction, tools, key, execute, reasoningEffort, conversation);
    if (this.agent.provider === "google") return this.runGoogle(instruction, tools, key, execute, reasoningEffort, conversation);
    if (this.agent.provider === "openai-responses") return this.runOpenAIResponses(instruction, tools, key, execute, reasoningEffort, conversation);
    return this.runOpenAICompatible(instruction, tools, key, execute, reasoningEffort, conversation);
  }
  private async request(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
    this.trace?.("model.request", { url, body });
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      throw new Error(`无法连接模型端点 ${url}：${error instanceof Error ? error.message : String(error)}`);
    }
    const payload = await response.json() as { error?: { message?: string; type?: string } };
    this.trace?.("model.response", { url, status: response.status, body: payload });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error(`模型鉴权失败（${response.status}）。请检查 ${this.agent.apiKeyEnv}、provider 和 baseUrl；密钥不要写入 YAML。`);
      if (payload.error?.type === "expired_key" || /expired\s+key/i.test(payload.error?.message ?? "")) throw new Error(`模型密钥已过期。请在工作区 .env 中更新 ${this.agent.apiKeyEnv}，然后重试。`);
      throw new Error(`模型请求失败（${response.status}）。请检查模型名、端点和服务端日志。`);
    }
    return payload;
  }
  /**
   * Keeps the same complete request/response audit trail as JSON responses, while passing each
   * parsed server-sent event to the caller immediately for renderer streaming.
   */
  private async streamRequest(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    onEvent: (event: Record<string, unknown>) => void,
    completeBody: () => unknown
  ): Promise<void> {
    this.trace?.("model.request", { url, body });
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, stream: true }), signal: AbortSignal.timeout(90_000) });
    } catch (error) {
      throw new Error(`无法连接模型端点 ${url}：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: { message?: string; type?: string } };
      this.trace?.("model.response", { url, status: response.status, body: payload });
      if (response.status === 401 || response.status === 403) throw new Error(`模型鉴权失败（${response.status}）。请检查 ${this.agent.apiKeyEnv}、provider 和 baseUrl；密钥不要写入 YAML。`);
      if (payload.error?.type === "expired_key" || /expired\s+key/i.test(payload.error?.message ?? "")) throw new Error(`模型密钥已过期。请在工作区 .env 中更新 ${this.agent.apiKeyEnv}，然后重试。`);
      throw new Error(`模型请求失败（${response.status}）。请检查模型名、端点和服务端日志。`);
    }
    if (!response.body) throw new Error("模型流式响应为空");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = (packet: string) => {
      const data = packet.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") return;
      try { onEvent(JSON.parse(data) as Record<string, unknown>); } catch { /* Ignore provider keep-alives and malformed SSE packets. */ }
    };
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const packets = buffer.split(/\r?\n\r?\n/);
      buffer = packets.pop() || "";
      for (const packet of packets) consume(packet);
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
    // This is deliberately a fully assembled response, not merely a stream summary: it is the
    // durable audit record required for every request sent to a model.
    this.trace?.("model.response", { url, status: response.status, body: completeBody() });
  }
  private async runOpenAICompatible(instruction: string, tools: AgentTool[], key: string, execute: ExecuteTool, reasoningEffort: ReasoningEffort, conversation?: ConversationMessage[]): Promise<string> {
    const history = conversation?.length ? conversation : [{ role: "user" as const, content: instruction }];
    const messages: Array<Record<string, unknown>> = [{ role: "system", content: this.agent.systemPrompt }, ...history.map((message) => ({ role: message.role, content: openAIContent(message) }))];
    const definitions = tools.map((tool) => ({ type: "function", function: { name: tool.key, description: tool.description || tool.key, parameters: tool.inputSchema || { type: "object", properties: {} } } }));
    for (let turn = 0; ; turn++) {
      let content = "";
      const toolCalls = new Map<number, { id?: string; function: { name?: string; arguments: string } }>();
      await this.streamRequest(`${this.agent.baseUrl}${this.agent.endpoint || "/chat/completions"}`, { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, {
        model: this.agent.model, messages, tools: definitions, max_tokens: this.agent.maxTokens, reasoning_effort: reasoningEffort
      }, (chunk) => {
        const delta = (chunk.choices as Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> | undefined)?.[0]?.delta;
        if (!delta) return;
          const reasoning = (delta as typeof delta & { reasoning_content?: string }).reasoning_content;
          if (typeof reasoning === "string") {
            this.trace?.("model.output.delta", { text: reasoning, kind: "thinking", turn: turn + 1 });
          }
          if (typeof delta.content === "string") {
            content += delta.content;
            this.trace?.("model.output.delta", { text: delta.content, kind: "answer", turn: turn + 1 });
        }
        for (const partial of delta.tool_calls || []) {
          const index = partial.index ?? 0;
          const current = toolCalls.get(index) || { function: { arguments: "" } };
          if (partial.id) current.id = partial.id;
          if (partial.function?.name) current.function.name = partial.function.name;
          if (partial.function?.arguments) current.function.arguments += partial.function.arguments;
          toolCalls.set(index, current);
        }
      }, () => ({ choices: [{ message: { content: content || null, tool_calls: [...toolCalls.values()] } }] }));
      const message = { content, tool_calls: [...toolCalls.values()] };
      const calls = message.tool_calls || [];
      if (!calls.length) return message.content.trim() || "已完成。";
      if (content) this.trace?.("model.output.reset", { turn: turn + 1, reason: "tool_call" });
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const name = call.function?.name;
        if (!name || !call.id) continue;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function?.arguments || "{}"); } catch { args = { _error: "模型返回了无法解析的工具参数" }; }
        if ("_error" in args) throw new Error("模型返回了无法解析的工具参数，请提高 maxTokens 或重试");
        let result: unknown;
        try { result = await execute(name, args); } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error("工具调用循环意外结束");
  }

  private async runOpenAIResponses(instruction: string, tools: AgentTool[], key: string, execute: ExecuteTool, reasoningEffort: ReasoningEffort, conversation?: ConversationMessage[]): Promise<string> {
    type InputItem = Record<string, unknown>;
    type FunctionCall = { callId: string; itemId?: string; name: string; arguments: string };
    const history = conversation?.length ? conversation : [{ role: "user" as const, content: instruction }];
    const input: InputItem[] = history.map((message) => ({ role: message.role, content: responsesContent(message) }));
    const definitions = tools.map((tool) => ({ type: "function", name: tool.key, description: tool.description || tool.key, parameters: tool.inputSchema || { type: "object", properties: {} }, strict: false }));
    for (let turn = 0; ; turn++) {
      let answer = "";
      let summaryDeltaSeen = false;
      let thinkingDeltaSeen = false;
      let responseOutput: InputItem[] = [];
      const calls = new Map<string, FunctionCall>();
      await this.streamRequest(`${this.agent.baseUrl}${this.agent.endpoint || "/responses"}`, { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, {
        model: this.agent.model,
        instructions: this.agent.systemPrompt,
        input,
        tools: definitions,
        max_output_tokens: this.agent.maxTokens,
        ...(isDeepSeekV4Model(this.agent.model)
          ? { reasoning: { effort: deepSeekReasoningEffort(reasoningEffort), summary: "auto" } }
          : isDoubaoModel(this.agent.model)
            ? doubaoReasoningFields(reasoningEffort)
            : { reasoning: { effort: reasoningEffort, summary: "auto" } })
      }, (event) => {
        const type = typeof event.type === "string" ? event.type : "";
        if (type === "response.output_text.delta" && typeof event.delta === "string") {
          answer += event.delta;
          this.trace?.("model.output.delta", { text: event.delta, kind: "answer", turn: turn + 1 });
        }
        if (type === "response.output_text.done" && !answer && typeof event.text === "string") {
          answer = event.text;
          this.trace?.("model.output.delta", { text: event.text, kind: "answer", turn: turn + 1 });
        }
        if (type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
          summaryDeltaSeen = true;
          this.trace?.("model.output.delta", { text: event.delta, kind: "summary", turn: turn + 1 });
        }
        if (type === "response.reasoning_summary_text.done" && !summaryDeltaSeen && typeof event.text === "string") {
          this.trace?.("model.output.delta", { text: event.text, kind: "summary", turn: turn + 1 });
        }
        if (type === "response.reasoning_text.delta" && typeof event.delta === "string") {
          thinkingDeltaSeen = true;
          this.trace?.("model.output.delta", { text: event.delta, kind: "thinking", turn: turn + 1 });
        }
        if (type === "response.reasoning_text.done" && !thinkingDeltaSeen && typeof event.text === "string") {
          this.trace?.("model.output.delta", { text: event.text, kind: "thinking", turn: turn + 1 });
        }
        if (type === "response.output_item.added" || type === "response.output_item.done") {
          const item = event.item as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
          if (item?.type === "function_call" && item.call_id) {
            const previous = calls.get(item.call_id);
            calls.set(item.call_id, { callId: item.call_id, itemId: typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : previous?.itemId, name: item.name || previous?.name || "", arguments: item.arguments || previous?.arguments || "" });
          }
        }
        if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
          const call = [...calls.values()].find((candidate) => candidate.itemId === event.item_id) || (typeof event.call_id === "string" ? calls.get(event.call_id) : undefined);
          if (call) {
            call.arguments += event.delta;
            calls.set(call.callId, call);
          }
        }
        if (type === "response.completed") {
          const response = event.response as { output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string; [key: string]: unknown }> } | undefined;
          responseOutput = (response?.output || []) as InputItem[];
          for (const item of response?.output || []) {
            if (item.type === "function_call" && item.call_id && item.name) calls.set(item.call_id, { callId: item.call_id, name: item.name, arguments: item.arguments || "" });
          }
        }
        if (type === "response.failed") {
          const failed = event.response as { error?: { message?: string; code?: string } } | undefined;
          throw new Error(failed?.error?.message || "妯″瀷璇锋眰澶辫触");
        }
      }, () => ({ output: [{ type: "message", content: answer || undefined }, ...[...calls.values()].map((call) => ({ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments }))] }));
      const functionCalls = [...calls.values()].filter((call) => call.name && call.callId);
      if (!functionCalls.length) return answer.trim() || "已完成。";
      if (answer) this.trace?.("model.output.reset", { turn: turn + 1, reason: "tool_call" });
      if (responseOutput.length) input.push(...responseOutput);
      for (const call of functionCalls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.arguments || "{}"); } catch { args = { _error: "模型返回了无法解析的工具参数" }; }
        if ("_error" in args) throw new Error("模型返回了无法解析的工具参数，请提高 maxTokens 或重试");
        if (!responseOutput.length) input.push({ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments });
        let result: unknown;
        try { result = await execute(call.name, args); } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
        input.push({ type: "function_call_output", call_id: call.callId, output: JSON.stringify(result) });
      }
    }
    throw new Error("工具调用循环意外结束");
  }
  private async runGoogle(instruction: string, tools: AgentTool[], key: string, execute: ExecuteTool, reasoningEffort: ReasoningEffort = "high", conversation?: ConversationMessage[]): Promise<string> {
    type Part = { text?: string; thought?: boolean; inlineData?: { mimeType: string; data: string }; functionCall?: { name?: string; args?: Record<string, unknown> }; functionResponse?: { name?: string; response?: unknown }; thoughtSignature?: string };
    const history = conversation?.length ? conversation : [{ role: "user" as const, content: instruction }];
    const contents: Array<{ role: "user" | "model"; parts: Part[] }> = history.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.attachments || []).map((attachment) => { const image = dataUrlParts(attachment); return { inlineData: { mimeType: image.mediaType, data: image.data } }; })
      ]
    }));
    const definitions = tools.map((tool) => ({ name: tool.key, description: tool.description || tool.key, parameters: toGoogleSchema(tool.inputSchema || { type: "object", properties: {} }) }));
    for (let turn = 0; ; turn++) {
      let text = "";
      const calls = new Map<string, { name: string; args: Record<string, unknown>; thoughtSignature?: string }>();
      const body = {
        systemInstruction: { parts: [{ text: this.agent.systemPrompt }] },
        contents,
        tools: [{ functionDeclarations: definitions }],
        generationConfig: { maxOutputTokens: this.agent.maxTokens, thinkingConfig: this.googleThinkingConfig(reasoningEffort) }
      };
      await this.streamGoogleRequest(`${this.agent.baseUrl}${this.agent.endpoint || `/models/${encodeURIComponent(this.agent.model || "gemini-2.5-flash")}:streamGenerateContent`}`, key, body, (chunk) => {
        const parts = (chunk.candidates as Array<{ content?: { parts?: Part[] } }> | undefined)?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (typeof part.text === "string") {
            text += part.text;
            this.trace?.("model.output.delta", { text: part.text, kind: part.thought ? "thinking" : "answer", turn: turn + 1 });
          }
          if (part.functionCall?.name) {
            const name = part.functionCall.name;
            const current = calls.get(name) || { name, args: {} };
            current.args = { ...current.args, ...(part.functionCall.args || {}) };
            const signature = part.thoughtSignature || (part as Part & { thought_signature?: string }).thought_signature;
            if (signature) current.thoughtSignature = signature;
            calls.set(name, current);
          }
        }
      }, () => ({ candidates: [{ content: { parts: [{ text: text || undefined }, ...[...calls.values()].map((call) => ({ functionCall: call }))] } }] }));
      const functionCalls = [...calls.values()];
      if (!functionCalls.length) return text.trim() || "已完成。";
      if (text) this.trace?.("model.output.reset", { turn: turn + 1, reason: "tool_call" });
      const modelParts: Part[] = [];
      if (text) modelParts.push({ text });
      modelParts.push(...functionCalls.map((call) => ({
        functionCall: { name: call.name, args: call.args },
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {})
      })));
      contents.push({ role: "model", parts: modelParts });
      for (const call of functionCalls) {
        let result: unknown;
        try { result = await execute(call.name, call.args); } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
        contents.push({ role: "user", parts: [{ functionResponse: { name: call.name, response: result } }] });
      }
    }
    throw new Error("工具调用循环意外结束");
  }

  private googleThinkingConfig(effort: ReasoningEffort): Record<string, unknown> {
    const model = this.agent.model.toLowerCase();
    if (model.includes("gemini-3")) return { thinkingLevel: effort === "none" ? "minimal" : effort === "max" || effort === "xhigh" ? "high" : effort };
    const budget = effort === "none" ? 0 : effort === "minimal" ? 512 : effort === "low" ? 1024 : effort === "medium" ? 4096 : effort === "max" || effort === "xhigh" ? 16384 : 8192;
    return { thinkingBudget: budget, includeThoughts: true };
  }
  private async streamGoogleRequest(url: string, key: string, body: unknown, onChunk: (chunk: Record<string, unknown>) => void, completeBody: () => unknown): Promise<void> {
    const requestUrl = `${url}${url.includes("?") ? "&" : "?"}alt=sse`;
    this.trace?.("model.request", { url, body });
    let response: Response;
    try { response = await fetch(requestUrl, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) }); }
    catch (error) { throw new Error(`无法连接 Google Gemini 端点 ${url}：${error instanceof Error ? error.message : String(error)}`); }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: { message?: string } };
      this.trace?.("model.response", { url, status: response.status, body: payload });
      if (response.status === 401 || response.status === 403) throw new Error("Google Gemini 鉴权失败，请检查 Google AI Studio API Key。");
      throw new Error(`Google Gemini 请求失败（${response.status}）：${payload.error?.message || "请检查模型名称和 API Key"}`);
    }
    if (!response.body) throw new Error("Google Gemini 流式响应为空");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = (packet: string) => {
      const data = packet.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
      if (!data) return;
      try { onChunk(JSON.parse(data) as Record<string, unknown>); } catch { /* Ignore incomplete provider packets. */ }
    };
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const packets = buffer.split(/\r?\n\r?\n/);
      buffer = packets.pop() || "";
      for (const packet of packets) consume(packet);
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
    this.trace?.("model.response", { url, status: response.status, body: completeBody() });
  }
  private async runAnthropic(instruction: string, tools: AgentTool[], key: string, execute: ExecuteTool, reasoningEffort: ReasoningEffort = "high", conversation?: ConversationMessage[]): Promise<string> {
    // The desktop session supplies structured turns. Keep the single-string fallback for CLI
    // callers that do not have a persisted conversation.
    const messages: Array<Record<string, unknown>> = conversation?.length
      ? conversation.map((message) => ({ role: message.role, content: message.attachments?.length ? [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...(message.attachments || []).map((attachment) => { const image = dataUrlParts(attachment); return { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }; })
      ] : message.content }))
      : [{ role: "user", content: instruction }];
    const definitions = tools.map((tool) => ({ name: tool.key, description: tool.description || tool.key, input_schema: tool.inputSchema || { type: "object", properties: {} } }));
    for (let turn = 0; ; turn++) {
      const blocks = new Map<number, { type?: string; id?: string; name?: string; text?: string; inputJson?: string; input?: Record<string, unknown> }>();
      await this.streamRequest(`${this.agent.baseUrl}${this.agent.endpoint || "/v1/messages"}`, {
        "Content-Type": "application/json", "x-api-key": key, "anthropic-version": this.agent.anthropicVersion || "2023-06-01"
      }, {
        model: this.agent.model,
        max_tokens: this.agent.maxTokens,
        system: this.agent.systemPrompt,
        messages,
        tools: definitions,
        ...this.anthropicThinkingConfig(reasoningEffort)
      }, (event) => {
        const type = event.type;
        const index = typeof event.index === "number" ? event.index : 0;
        if (type === "content_block_start") {
          const block = event.content_block as { type?: string; id?: string; name?: string; text?: string; input?: Record<string, unknown> } | undefined;
          // Anthropic sends an empty `{}` in tool_use starts, followed by input_json_delta
          // fragments. Do not seed that placeholder or it becomes `{}{...}`.
          blocks.set(index, { ...block, inputJson: Object.keys(block?.input || {}).length ? JSON.stringify(block?.input) : "" });
        }
        if (type === "content_block_delta") {
          const current = blocks.get(index) || {};
          const delta = event.delta as { type?: string; text?: string; partial_json?: string } | undefined;
          if (delta?.type === "thinking_delta" && typeof (delta as typeof delta & { thinking?: string }).thinking === "string") {
            this.trace?.("model.output.delta", { text: (delta as typeof delta & { thinking: string }).thinking, kind: "thinking", turn: turn + 1 });
          }
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            current.text = (current.text || "") + delta.text;
            this.trace?.("model.output.delta", { text: delta.text, kind: "answer", turn: turn + 1 });
          }
          if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") current.inputJson = (current.inputJson || "") + delta.partial_json;
          blocks.set(index, current);
        }
      }, () => ({ content: [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => ({
        type: block.type,
        id: block.id,
        name: block.name,
        text: block.text,
        input: block.type === "tool_use" ? this.parseToolInput(block.inputJson) : undefined
      })) }));
      const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => ({
        type: block.type,
        id: block.id,
        name: block.name,
        text: block.text,
        input: block.type === "tool_use" ? this.parseToolInput(block.inputJson) : undefined
      }));
      const calls = content.filter((item) => item.type === "tool_use" && item.id && item.name);
      if (!calls.length) return content.filter((item) => item.type === "text").map((item) => item.text).filter(Boolean).join("\n") || "已完成。";
      if (content.some((item) => item.type === "text" && item.text)) this.trace?.("model.output.reset", { turn: turn + 1, reason: "tool_call" });
      messages.push({ role: "assistant", content });
      const results: Array<Record<string, unknown>> = [];
      for (const call of calls) {
        if (call.input && "_error" in call.input) throw new Error("模型返回了无法解析的工具参数，请提高 maxTokens 或重试");
        let result: unknown;
        try { result = await execute(call.name!, call.input || {}); } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "user", content: results });
    }
    throw new Error("工具调用循环意外结束");
  }
  private parseToolInput(input: string | undefined): Record<string, unknown> {
    try { return JSON.parse(input || "{}") as Record<string, unknown>; }
    catch { return { _error: "模型返回了无法解析的工具参数" }; }
  }

  private anthropicThinkingConfig(effort: ReasoningEffort): Record<string, unknown> {
    if (effort === "none") return {};
    const model = this.agent.model.toLowerCase();
    const adaptive = /claude-(?:opus|sonnet|haiku)-(?:4-6|4-7|4-8|5)/.test(model);
    if (adaptive) return { thinking: { type: "adaptive" }, output_config: { effort: effort === "max" || effort === "xhigh" ? "high" : effort === "minimal" ? "low" : effort } };
    const budget = effort === "minimal" ? 512 : effort === "low" ? 1024 : effort === "medium" ? 4096 : effort === "max" || effort === "xhigh" ? 16384 : 8192;
    return { thinking: { type: "enabled", budget_tokens: Math.min(budget, Math.max(1024, this.agent.maxTokens - 1)) } };
  }
}
