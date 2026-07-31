import type { SecAgentConfig } from "./types.js";
import type { RegisteredMcpTool } from "./mcp-adapter.js";
import type { LoadedSkill } from "./skills.js";

type ExecuteTool = (key: string, args: Record<string, unknown>) => Promise<unknown>;
export type AgentTool = Pick<RegisteredMcpTool, "key" | "description" | "inputSchema">;
type ModelTrace = (stage: string, data: unknown) => void;

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
  constructor(config: SecAgentConfig, skills: LoadedSkill[], private trace?: ModelTrace) {
    const skillCatalog = skills.length
      ? `\n\n## 可用 Skills\n${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}`
      : "";
    this.agent = { ...config.agent, systemPrompt: `${config.agent.systemPrompt}${skillCatalog}` };
  }
  async run(instruction: string, tools: AgentTool[], execute: ExecuteTool): Promise<string> {
    if (!tools.length) throw new Error("没有已启用且可发现的 MCP 工具");
    const key = process.env[this.agent.apiKeyEnv];
    if (!key) throw new Error(`未配置模型密钥环境变量 ${this.agent.apiKeyEnv}。请设置后重试；密钥不要写入 secagent.yaml。`);
    if (this.agent.provider === "anthropic") return this.runAnthropic(instruction, tools, key, execute);
    if (this.agent.provider === "google") return this.runGoogle(instruction, tools, key, execute);
    return this.runOpenAICompatible(instruction, tools, key, execute);
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
  private async runOpenAICompatible(instruction: string, tools: AgentTool[], key: string, execute: ExecuteTool): Promise<string> {
    const messages: Array<Record<string, unknown>> = [{ role: "system", content: this.agent.systemPrompt }, { role: "user", content: instruction }];
    const definitions = tools.map((tool) => ({ type: "function", function: { name: tool.key, description: tool.description || tool.key, parameters: tool.inputSchema || { type: "object", properties: {} } } }));
    for (let turn = 0; turn < 8; turn++) {
      let content = "";
      const toolCalls = new Map<number, { id?: string; function: { name?: string; arguments: string } }>();
      await this.streamRequest(`${this.agent.baseUrl}${this.agent.endpoint || "/chat/completions"}`, { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, {
        model: this.agent.model, messages, tools: definitions, max_tokens: this.agent.maxTokens
      }, (chunk) => {
        const delta = (chunk.choices as Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> | undefined)?.[0]?.delta;
        if (!delta) return;
        if (typeof delta.content === "string") {
          content += delta.content;
          this.trace?.("model.output.delta", { text: delta.content, turn: turn + 1 });
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
        let result: unknown;
        try { result = await execute(name, args); } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error("模型工具调用超过最大轮数（8）");
  }
  private async runGoogle(instruction: string, tools: AgentTool[], key: string, execute: ExecuteTool): Promise<string> {
    type Part = { text?: string; functionCall?: { name?: string; args?: Record<string, unknown> }; functionResponse?: { name?: string; response?: unknown }; thoughtSignature?: string };
    const contents: Array<{ role: "user" | "model"; parts: Part[] }> = [{ role: "user", parts: [{ text: instruction }] }];
    const definitions = tools.map((tool) => ({ name: tool.key, description: tool.description || tool.key, parameters: toGoogleSchema(tool.inputSchema || { type: "object", properties: {} }) }));
    for (let turn = 0; turn < 8; turn++) {
      let text = "";
      const calls = new Map<string, { name: string; args: Record<string, unknown>; thoughtSignature?: string }>();
      const body = {
        systemInstruction: { parts: [{ text: this.agent.systemPrompt }] },
        contents,
        tools: [{ functionDeclarations: definitions }],
        generationConfig: { maxOutputTokens: this.agent.maxTokens }
      };
      await this.streamGoogleRequest(`${this.agent.baseUrl}${this.agent.endpoint || `/models/${encodeURIComponent(this.agent.model || "gemini-2.5-flash")}:streamGenerateContent`}`, key, body, (chunk) => {
        const parts = (chunk.candidates as Array<{ content?: { parts?: Part[] } }> | undefined)?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (typeof part.text === "string") {
            text += part.text;
            this.trace?.("model.output.delta", { text: part.text, turn: turn + 1 });
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
    throw new Error("模型工具调用超过最大轮数（8）");
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
  private async runAnthropic(instruction: string, tools: AgentTool[], key: string, execute: ExecuteTool): Promise<string> {
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: instruction }];
    const definitions = tools.map((tool) => ({ name: tool.key, description: tool.description || tool.key, input_schema: tool.inputSchema || { type: "object", properties: {} } }));
    for (let turn = 0; turn < 8; turn++) {
      const blocks = new Map<number, { type?: string; id?: string; name?: string; text?: string; inputJson?: string; input?: Record<string, unknown> }>();
      await this.streamRequest(`${this.agent.baseUrl}${this.agent.endpoint || "/v1/messages"}`, {
        "Content-Type": "application/json", "x-api-key": key, "anthropic-version": this.agent.anthropicVersion || "2023-06-01"
      }, {
        model: this.agent.model, max_tokens: this.agent.maxTokens, system: this.agent.systemPrompt, messages, tools: definitions
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
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            current.text = (current.text || "") + delta.text;
            this.trace?.("model.output.delta", { text: delta.text, turn: turn + 1 });
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
        let result: unknown;
        try { result = await execute(call.name!, call.input || {}); } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "user", content: results });
    }
    throw new Error("模型工具调用超过最大轮数（8）");
  }
  private parseToolInput(input: string | undefined): Record<string, unknown> {
    try { return JSON.parse(input || "{}") as Record<string, unknown>; }
    catch { return { _error: "模型返回了无法解析的工具参数" }; }
  }
}
