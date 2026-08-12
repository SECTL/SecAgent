import type { PluginPromptContribution } from "./plugin-manager.js";
import type { ChatAttachment, ReasoningEffort, SecAgentConfig } from "./types.js";
import { toolResultParts, toolResultText } from "./tool-content.js";

const WORKSPACE_FILE_OUTPUT_PROMPT = `

## 工作区文件预览输出
当本轮任务生成或修改了可供用户浏览的 HTML、SVG 或 Markdown 文件（例如交互效果、静态网站、图表或文档）时，请在最终回答的最后追加一个工作区文件清单。只列出确实存在于当前工作区内的文件，路径使用相对工作区根目录的路径，并严格使用以下 XML 格式；没有可预览文件时不要输出该标签：
<workspace-files>
  <file path="相对路径/index.html" />
</workspace-files>
可以列出一个或多个文件。XML 必须放在回答末尾，不要放进 Markdown 代码块。`;

const MAFS_RENDERING_PROMPT = `

## 数学图示
解释数学内容时，优先使用 Markdown 中的 <Mafs>...</Mafs> 或 <R3F>...</R3F> 绘制图示。对于函数、坐标、几何、立体、积分、运动、向量、面积体积等内容，只要图示能够表达关键关系，就必须在最终回答正文中实际输出对应标签，不能只在思考中提到“可以画图”。图示用于辅助文字推导和公式说明，不要因为推导是逻辑过程就省略图示。二维关系优先使用 Mafs，三维几何优先使用 R3F。标签内必须是 JSON：可包含 viewBox、coordinates 和 plots；plots 支持 function（或 ofX，expression/formula）、point、circle、segment、vector、text。segment 使用 start/end 或 x1/y1/x2/y2。图示默认支持鼠标拖动和平移、滚轮缩放，可用 pan/zoom 关闭。函数表达式使用 x、数字、四则运算、^ 以及常见数学函数（sin、cos、tan、sqrt、abs、log、exp 等）。示例：
<Mafs>
{"viewBox":{"x":[-5,5],"y":[-3,3]},"plots":[{"type":"function","expression":"sin(x)","domain":[-5,5]}]}
</Mafs>
只有在确实没有任何可视化价值的纯定义、简单算术或纯符号变形中才可以不画图。`;

const R3F_RENDERING_PROMPT = `

## 三维交互图示
三维几何、空间结构或立体数学内容必须优先使用 Markdown 的 <R3F>...</R3F>，除非内容确实没有可视化价值。不要只画一个孤立的圆柱和一个孤立的圆锥；图示必须服务于推导，展示对象之间的对应关系、变形过程和关键尺寸。讲“等积变形”时，应同时画原图形、切分/重排后的近似图形，并用 dimension 标出对应的半径、周长、底边、高等长度，使用 text 标出每部分含义；二维的底面切分和扇形重排优先另加一个 <Mafs> 图示。标签内必须是 JSON 场景描述，不要输出 JSX、JavaScript 或 HTML。可包含 camera、background、controls、grid、shadows 和 objects；objects 支持 box、sphere、cylinder、cone、torus、plane、line、circle、dimension、text、grid，并可设置 position、rotation、scale、color、opacity、wireframe。line 可使用 points 或 start/end；dimension 使用 start、end、label；circle 使用 center、radius；text 的文字使用 text 字段。场景默认支持拖动旋转、滚轮缩放和右键平移，可用 controls:false 关闭。

例如，圆面积变成长方形时必须说明并标出：圆的半径为 r，圆周长为 2πr；将圆切成许多扇形并交错排列后，近似长方形的长为 πr（圆周长的一半），宽为 r，面积对应关系为 πr×r=πr²。圆柱体再沿高 h 方向延伸，近似长方体的三条对应长度为 πr、r、h，体积对应关系为 πr×r×h=πr²h。不要只用文字声称这些关系，必须在图中用标注表达。示例：
<R3F>
{"camera":{"position":[4,3,5]},"objects":[{"type":"box","position":[0,0,0],"color":"#4f8fd9"},{"type":"sphere","position":[1,1,0],"radius":0.6,"color":"#f59e0b"}]}
</R3F>
`;

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
export interface ConversationMessage { role: "user" | "assistant" | "system"; content: string; attachments?: ChatAttachment[] }
type ModelTrace = (stage: string, data: unknown) => void;
type RetryableModelError = Error & { retryable?: boolean };

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
  constructor(config: SecAgentConfig, _skills: LoadedSkill[], private trace?: ModelTrace, private getExtraPrompts?: () => Promise<PluginPromptContribution[]>) {
    const skillCatalog = _skills.length
      ? `\n\n## 可用 Skills\n${_skills.map((skill) => `- ${skill.name}: ${skill.description}（入口文件：${skill.relativePath || skill.path}）`).join("\n")}`
      : "";
    this.agent = { ...config.agent, systemPrompt: `${config.agent.systemPrompt}${skillCatalog}${WORKSPACE_FILE_OUTPUT_PROMPT}` };
  }
  async run(instruction: string, tools: AgentTool[], execute: ExecuteTool, reasoningEffort: ReasoningEffort = "high", conversation?: ConversationMessage[], signal?: AbortSignal): Promise<string> {
    if (!tools.length) throw new Error("没有已启用且可发现的 MCP 工具");
    const key = process.env[this.agent.apiKeyEnv];
    if (!key) throw new Error(`未配置模型密钥环境变量 ${this.agent.apiKeyEnv}。请设置后重试；密钥不要写入 secagent.yaml。`);
    const systemPrompt = await this.resolveSystemPrompt();
    if (this.agent.provider === "anthropic") return this.runAnthropic(instruction, tools, key, execute, reasoningEffort, systemPrompt, conversation, signal);
    if (this.agent.provider === "google") return this.runGoogle(instruction, tools, key, execute, reasoningEffort, systemPrompt, conversation, signal);
    if (this.agent.provider === "openai-responses") return this.runOpenAIResponses(instruction, tools, key, execute, reasoningEffort, systemPrompt, conversation, signal);
    return this.runOpenAICompatible(instruction, tools, key, execute, reasoningEffort, systemPrompt, conversation, signal);
  }
  /** 每次请求前从插件收集提示词并拼接到系统提示词最后；无插件提示词时原样返回。 */
  private async resolveSystemPrompt(): Promise<string> {
    const contributions = await this.getExtraPrompts?.() || [];
    if (!contributions.length) return this.agent.systemPrompt;
    const catalog = contributions.map(({ pluginId, name, text }) => `[${pluginId}/${name}]\n${text}`).join("\n\n");
    return `${this.agent.systemPrompt}\n\n## 插件注入的提示词\n${catalog}`;
  }
  private async request(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<unknown> {
    this.trace?.("model.request", { url, body });
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
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
    completeBody: () => unknown,
    signal?: AbortSignal
  ): Promise<void> {
    const maxRetries = 5;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.streamRequestOnce(url, headers, body, onEvent, completeBody, signal);
        return;
      } catch (error) {
        if (signal?.aborted) throw error;
        const retryable = error as RetryableModelError;
        const message = error instanceof Error ? error.message : String(error);
        const transientConnectionError = /terminated|network|socket|closed|reset|timeout|fetch failed/i.test(message);
        if ((!retryable.retryable && !transientConnectionError) || attempt >= maxRetries) throw error;
        const waitMs = Math.min(5000, 350 * 2 ** attempt);
        this.trace?.("model.retry", { url, attempt: attempt + 1, maxRetries, waitMs, error: message });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, waitMs);
          signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
      }
    }
  }

  private async streamRequestOnce(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    onEvent: (event: Record<string, unknown>) => void,
    completeBody: () => unknown,
    signal?: AbortSignal
  ): Promise<void> {
    this.trace?.("model.request", { url, body });
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, stream: true }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`无法连接模型端点 ${url}：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: { message?: string; type?: string } };
      this.trace?.("model.response", { url, status: response.status, body: payload });
      const retryableStatus = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      if (retryableStatus) {
        const requestError = new Error(`model API request failed (${response.status})`) as RetryableModelError;
        requestError.retryable = true;
        throw requestError;
      }
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
  private async runOpenAICompatible(instruction: string, tools: AgentTool[], key: string, execute: ExecuteTool, reasoningEffort: ReasoningEffort, systemPrompt: string, conversation?: ConversationMessage[], signal?: AbortSignal): Promise<string> {
    const history = conversation?.length ? conversation : [{ role: "user" as const, content: instruction }];
    const messages: Array<Record<string, unknown>> = [{ role: "system", content: systemPrompt }, ...history.map((message) => ({ role: message.role, content: openAIContent(message) }))];
    const definitions = tools.map((tool) => ({ type: "function", function: { name: tool.key, description: tool.description || tool.key, parameters: tool.inputSchema || { type: "object", properties: {} } } }));
    let pendingToolError: string | undefined;
    let emptyResponseRetries = 0;
    for (let turn = 0; ; turn++) {
      let content = "";
      const toolCalls = new Map<number, { id?: string; function: { name?: string; arguments: string } }>();
      signal?.throwIfAborted();
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
      }, () => ({ choices: [{ message: { content: content || null, tool_calls: [...toolCalls.values()] } }] }), signal);
      const message = { content, tool_calls: [...toolCalls.values()] };
      const calls = message.tool_calls || [];
      if (!calls.length) {
        if (!message.content.trim() && !pendingToolError && emptyResponseRetries < 1) {
          emptyResponseRetries += 1;
          messages.push({ role: "user", content: "请直接给出最终答复，不要只输出思考过程；如果需要调用工具，请调用工具后继续完成任务。" });
          continue;
        }
        return message.content.trim() || (pendingToolError ? `工具执行失败：${pendingToolError}` : "模型响应为空。");
      }
      if (content) this.trace?.("model.output.reset", { turn: turn + 1, reason: "tool_call" });
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls.map((call) => ({ ...call, type: "function" })) });
      let turnToolError: string | undefined;
      const imageFollowups = [] as ReturnType<typeof toolResultParts>["images"];
      for (const call of calls) {
        const name = call.function?.name;
        if (!name || !call.id) continue;
        let args: Record<string, unknown> | undefined;
        let result: unknown;
        try {
          args = JSON.parse(call.function?.arguments || "{}");
        } catch {
          result = { error: "工具参数不是有效的 JSON，请重新生成完整且合法的工具参数。" };
        }
        if (!result) {
          signal?.throwIfAborted();
          try { result = await execute(name, args!); } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            turnToolError ??= message;
            result = { error: message };
          }
        }
        const parts = toolResultParts(result);
        messages.push({ role: "tool", tool_call_id: call.id, content: toolResultText(parts) });
        imageFollowups.push(...parts.images);
      }
      if (imageFollowups.length) messages.push({ role: "user", content: [{ type: "text", text: "工具返回了图片，请直接查看这些图片并继续完成任务。" }, ...imageFollowups.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }))] });
      pendingToolError = turnToolError;
    }
    throw new Error("工具调用循环意外结束");
  }

  private async runOpenAIResponses(instruction: string, tools: AgentTool[], key: string, execute: ExecuteTool, reasoningEffort: ReasoningEffort, systemPrompt: string, conversation?: ConversationMessage[], signal?: AbortSignal): Promise<string> {
    type InputItem = Record<string, unknown>;
    type FunctionCall = { callId: string; itemId?: string; name: string; arguments: string };
    const history = conversation?.length ? conversation : [{ role: "user" as const, content: instruction }];
    const input: InputItem[] = history.map((message) => ({ role: message.role, content: responsesContent(message) }));
    const definitions = tools.map((tool) => ({ type: "function", name: tool.key, description: tool.description || tool.key, parameters: tool.inputSchema || { type: "object", properties: {} }, strict: false }));
    let pendingToolError: string | undefined;
    let emptyResponseRetries = 0;
    for (let turn = 0; ; turn++) {
      let answer = "";
      let summaryDeltaSeen = false;
      let thinkingDeltaSeen = false;
      let responseOutput: InputItem[] = [];
      const calls = new Map<string, FunctionCall>();
      signal?.throwIfAborted();
      await this.streamRequest(`${this.agent.baseUrl}${this.agent.endpoint || "/responses"}`, { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, {
        model: this.agent.model,
        instructions: systemPrompt,
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
          // Some Responses-compatible relays emit the final message only in
          // response.completed (without response.output_text.delta events).
          // Preserve that text instead of incorrectly reporting an empty
          // response to the caller.
          if (!answer) {
            const completedText = (response as { output_text?: unknown } | undefined)?.output_text;
            if (typeof completedText === "string") {
              answer = completedText;
            } else {
              const textParts = (response?.output || [])
                .filter((item) => item.type === "message")
                .flatMap((item) => {
                  const content = item.content;
                  if (typeof content === "string") return [content];
                  if (!Array.isArray(content)) return [];
                  return content.flatMap((part) => typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []);
                });
              answer = textParts.join("");
            }
            if (answer) this.trace?.("model.output.delta", { text: answer, kind: "answer", turn: turn + 1 });
          }
          for (const item of response?.output || []) {
            if (item.type === "function_call" && item.call_id && item.name) calls.set(item.call_id, { callId: item.call_id, name: item.name, arguments: item.arguments || "" });
          }
        }
        if (type === "response.failed") {
          const failed = event.response as { error?: { message?: string; code?: string } } | undefined;
          throw new Error(failed?.error?.message || "妯″瀷璇锋眰澶辫触");
        }
      }, () => ({ output: [{ type: "message", content: answer || undefined }, ...[...calls.values()].map((call) => ({ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments }))] }), signal);
      const functionCalls = [...calls.values()].filter((call) => call.name && call.callId);
      if (!functionCalls.length) {
        if (!answer.trim() && !pendingToolError && emptyResponseRetries < 1) {
          emptyResponseRetries += 1;
          input.push({ role: "user", content: "请直接给出最终答复，不要只输出思考过程；如果需要调用工具，请调用工具后继续完成任务。" });
          continue;
        }
        return answer.trim() || (pendingToolError ? `工具执行失败：${pendingToolError}` : "模型响应为空。");
      }
      if (answer) this.trace?.("model.output.reset", { turn: turn + 1, reason: "tool_call" });
      if (responseOutput.length) input.push(...responseOutput);
      let turnToolError: string | undefined;
      for (const call of functionCalls) {
        let args: Record<string, unknown> | undefined;
        let result: unknown;
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {
          result = { error: "工具参数不是有效的 JSON，请重新生成完整且合法的工具参数。" };
        }
        if (!responseOutput.length) input.push({ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments });
        if (!result) {
          signal?.throwIfAborted();
          try { result = await execute(call.name, args!); } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            turnToolError ??= message;
            result = { error: message };
          }
        }
        const parts = toolResultParts(result);
        input.push({ type: "function_call_output", call_id: call.callId, output: parts.images.length ? [{ type: "input_text", text: toolResultText(parts) }, ...parts.images.map((image) => ({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` }))] : toolResultText(parts) });
      }
      pendingToolError = turnToolError;
    }
    throw new Error("工具调用循环意外结束");
  }
  private async runGoogle(instruction: string, tools: AgentTool[], key: string, execute: ExecuteTool, reasoningEffort: ReasoningEffort = "high", systemPrompt: string, conversation?: ConversationMessage[], signal?: AbortSignal): Promise<string> {
    type Part = { text?: string; thought?: boolean; inlineData?: { mimeType: string; data: string }; functionCall?: { name?: string; args?: Record<string, unknown>; id?: string }; functionResponse?: { name?: string; response?: unknown; id?: string; parts?: Array<{ inlineData: { mimeType: string; data: string; displayName?: string } }> }; thoughtSignature?: string };
    const history = conversation?.length ? conversation : [{ role: "user" as const, content: instruction }];
    const dynamicSystem = history.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const contents: Array<{ role: "user" | "model"; parts: Part[] }> = history.filter((message) => message.role !== "system").map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.attachments || []).map((attachment) => { const image = dataUrlParts(attachment); return { inlineData: { mimeType: image.mediaType, data: image.data } }; })
      ]
    }));
    const definitions = tools.map((tool) => ({ name: tool.key, description: tool.description || tool.key, parameters: toGoogleSchema(tool.inputSchema || { type: "object", properties: {} }) }));
    let pendingToolError: string | undefined;
    for (let turn = 0; ; turn++) {
      let text = "";
      const calls = new Map<string, { name: string; args: Record<string, unknown>; thoughtSignature?: string; id?: string }>();
      const body = {
        systemInstruction: { parts: [{ text: dynamicSystem ? `${systemPrompt}\n\n${dynamicSystem}` : systemPrompt }] },
        contents,
        tools: [{ functionDeclarations: definitions }],
        generationConfig: { maxOutputTokens: this.agent.maxTokens, thinkingConfig: this.googleThinkingConfig(reasoningEffort) }
      };
      signal?.throwIfAborted();
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
            if (part.functionCall.id) current.id = part.functionCall.id;
            const signature = part.thoughtSignature || (part as Part & { thought_signature?: string }).thought_signature;
            if (signature) current.thoughtSignature = signature;
            calls.set(name, current);
          }
        }
      }, () => ({ candidates: [{ content: { parts: [{ text: text || undefined }, ...[...calls.values()].map((call) => ({ functionCall: call }))] } }] }), signal);
      const functionCalls = [...calls.values()];
      if (!functionCalls.length) return text.trim() || (pendingToolError ? `工具执行失败：${pendingToolError}` : "模型响应为空。");
      if (text) this.trace?.("model.output.reset", { turn: turn + 1, reason: "tool_call" });
      const modelParts: Part[] = [];
      if (text) modelParts.push({ text });
      modelParts.push(...functionCalls.map((call) => ({
        functionCall: { name: call.name, args: call.args },
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {})
      })));
      contents.push({ role: "model", parts: modelParts });
      let turnToolError: string | undefined;
      const imageFallback = [] as Part[];
      for (const call of functionCalls) {
        let result: unknown;
        signal?.throwIfAborted();
        try { result = await execute(call.name, call.args); } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          turnToolError ??= message;
          result = { error: message };
        }
        const parts = toolResultParts(result);
        if (parts.images.length && this.agent.model.toLowerCase().includes("gemini-3")) {
          const refs = parts.images.map((image, index) => ({ $ref: `${call.name}-${turn}-${index}` }));
          contents.push({ role: "user", parts: [{ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: { result: parts.text || "已返回图片。", images: refs }, parts: parts.images.map((image, index) => ({ inlineData: { mimeType: image.mimeType, data: image.data, displayName: `${call.name}-${turn}-${index}` } })) } }] });
        } else {
          contents.push({ role: "user", parts: [{ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: parts.images.length ? { result: toolResultText(parts) } : result } }] });
          imageFallback.push(...parts.images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })));
        }
      }
      if (imageFallback.length) contents.push({ role: "user", parts: [{ text: "工具返回了图片，请直接查看这些图片并继续完成任务。" }, ...imageFallback] });
      pendingToolError = turnToolError;
    }
    throw new Error("工具调用循环意外结束");
  }

  private googleThinkingConfig(effort: ReasoningEffort): Record<string, unknown> {
    const model = this.agent.model.toLowerCase();
    if (model.includes("gemini-3")) return { thinkingLevel: effort === "none" ? "minimal" : effort === "max" || effort === "xhigh" ? "high" : effort };
    const budget = effort === "none" ? 0 : effort === "minimal" ? 512 : effort === "low" ? 1024 : effort === "medium" ? 4096 : effort === "max" || effort === "xhigh" ? 16384 : 8192;
    return { thinkingBudget: budget, includeThoughts: true };
  }
  private async streamGoogleRequest(url: string, key: string, body: unknown, onChunk: (chunk: Record<string, unknown>) => void, completeBody: () => unknown, signal?: AbortSignal): Promise<void> {
    const requestUrl = `${url}${url.includes("?") ? "&" : "?"}alt=sse`;
    this.trace?.("model.request", { url, body });
    let response: Response;
    try { response = await fetch(requestUrl, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000) }); }
    catch (error) { if (signal?.aborted) throw error; throw new Error(`无法连接 Google Gemini 端点 ${url}：${error instanceof Error ? error.message : String(error)}`); }
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
  private async runAnthropic(instruction: string, tools: AgentTool[], key: string, execute: ExecuteTool, reasoningEffort: ReasoningEffort = "high", systemPrompt: string, conversation?: ConversationMessage[], signal?: AbortSignal): Promise<string> {
    // The desktop session supplies structured turns. Keep the single-string fallback for CLI
    // callers that do not have a persisted conversation.
    const dynamicSystem = (conversation || []).filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const messages: Array<Record<string, unknown>> = conversation?.length
      ? conversation.filter((message) => message.role !== "system").map((message) => ({ role: message.role, content: message.attachments?.length ? [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...(message.attachments || []).map((attachment) => { const image = dataUrlParts(attachment); return { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }; })
      ] : message.content }))
      : [{ role: "user", content: instruction }];
    const definitions = tools.map((tool) => ({ name: tool.key, description: tool.description || tool.key, input_schema: tool.inputSchema || { type: "object", properties: {} } }));
    let pendingToolError: string | undefined;
    for (let turn = 0; ; turn++) {
      const blocks = new Map<number, { type?: string; id?: string; name?: string; text?: string; inputJson?: string; input?: Record<string, unknown> }>();
      signal?.throwIfAborted();
      await this.streamRequest(`${this.agent.baseUrl}${this.agent.endpoint || "/v1/messages"}`, {
        "Content-Type": "application/json", "x-api-key": key, "anthropic-version": this.agent.anthropicVersion || "2023-06-01"
      }, {
        model: this.agent.model,
        max_tokens: this.agent.maxTokens,
        system: dynamicSystem ? `${systemPrompt}\n\n${dynamicSystem}` : systemPrompt,
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
      })) }), signal);
      const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => ({
        type: block.type,
        id: block.id,
        name: block.name,
        text: block.text,
        input: block.type === "tool_use" ? this.parseToolInput(block.inputJson) : undefined
      }));
      const calls = content.filter((item) => item.type === "tool_use" && item.id && item.name);
      if (!calls.length) {
        const answer = content.filter((item) => item.type === "text").map((item) => item.text).filter(Boolean).join("\n");
        return answer || (pendingToolError ? `工具执行失败：${pendingToolError}` : "模型响应为空。");
      }
      if (content.some((item) => item.type === "text" && item.text)) this.trace?.("model.output.reset", { turn: turn + 1, reason: "tool_call" });
      messages.push({ role: "assistant", content });
      const results: Array<Record<string, unknown>> = [];
      let turnToolError: string | undefined;
      for (const call of calls) {
        if (call.input && "_error" in call.input) {
          // Malformed tool JSON is a model error, not a client-fatal error.
          // Return it as a normal tool result so the model can regenerate the
          // arguments and continue the task.
          results.push({ type: "tool_result", tool_use_id: call.id, content: String(call.input._error) });
          continue;
        }
        if (call.input && "_error" in call.input) throw new Error("模型返回了无法解析的工具参数，请提高 maxTokens 或重试");
        let result: unknown;
        signal?.throwIfAborted();
        try { result = await execute(call.name!, call.input || {}); } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          turnToolError ??= message;
          result = { error: message };
        }
        const parts = toolResultParts(result);
        results.push({ type: "tool_result", tool_use_id: call.id, content: parts.images.length ? [{ type: "text", text: toolResultText(parts) }, ...parts.images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } }))] : toolResultText(parts) });
      }
      messages.push({ role: "user", content: results });
      pendingToolError = turnToolError;
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
