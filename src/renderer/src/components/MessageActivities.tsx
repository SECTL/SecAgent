import { AnimatedDetails } from "./AnimatedDetails.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { toolTitle } from "../utils.js";

type ToolActivity = Extract<AssistantActivity, { kind: "tool" }>;

const localTools = new Set(["look_at", "read", "write", "edit", "bash"]);

function resultText(activity: ToolActivity): string {
  if (typeof activity.result === "string") return activity.result;
  if (!activity.result || typeof activity.result !== "object") return "";
  const result = activity.result as { stdout?: unknown; stderr?: unknown };
  return `${typeof result.stdout === "string" ? result.stdout : ""}\n${typeof result.stderr === "string" ? result.stderr : ""}`;
}

function gitSummary(activities: ToolActivity): string[] {
  const summaries: string[] = [];
  if (!("result" in activities)) return summaries;
  const command = typeof activities.arguments === "object" && activities.arguments !== null
    ? String((activities.arguments as { command?: unknown }).command ?? "")
    : "";
  const output = resultText(activities);
  if (/\berror\b/i.test(output) && !/nothing to commit/i.test(output)) return summaries;

  if (/\bgit\s+commit\b/i.test(command)) {
    const hash = output.match(/\[[^\]]+\s+([0-9a-f]{7,40})\]/i)?.[1];
    summaries.push(hash ? `Committed ${hash}` : "Committed");
  }
  if (/\bgit\s+push\b/i.test(command)) {
    const pushArgs = command.match(/\bgit\s+push\s+(?:-\S+\s+)*(\S+)(?:\s+(\S+))?/i);
    const pushed = output.match(/\b([^\s]+)\s+->\s+([^\s]+)/)?.slice(1) ?? [];
    const remote = pushArgs?.[1] || pushed[0];
    const branch = pushArgs?.[2] || pushed[1];
    summaries.push(remote && branch ? `Pushed ${remote} ${branch}` : "Pushed");
  }
  return summaries;
}

function executionSummary(activities: AssistantActivity[]): string {
  const tools = activities.filter((activity): activity is ToolActivity => activity.kind === "tool");
  const reads = new Set(tools.filter((activity) => activity.name === "read").map((activity) => {
    const args = activity.arguments as { path?: unknown };
    return typeof args?.path === "string" ? args.path : "";
  }).filter(Boolean));
  const readCount = reads.size || tools.filter((activity) => activity.name === "read").length;
  const commandCount = tools.filter((activity) => activity.name === "bash").length;
  const parts: string[] = [];
  if (readCount) parts.push(`读取了${readCount}个文件`);
  if (commandCount) parts.push(`执行了${commandCount}条命令`);

  const external = [...new Set(tools.filter((activity) => !localTools.has(activity.name)).map((activity) => activity.name.split("__")[0]))];
  if (external.length) {
    const first = toolTitle(external[0]);
    parts.push(external.length === 1 ? `调用了${first}` : `调用了${first}和${external.length - 1}个其它工具`);
  }
  if (!parts.length && tools.length) parts.push(`调用了${tools.length}个工具`);

  const git = tools.flatMap(gitSummary);
  return [...parts, ...git].join("，");
}

export function MessageActivities({ activities, elapsedSeconds, isExecuting = false, stopped = false, activeStepKind, summaryRef }: { activities: AssistantActivity[]; elapsedSeconds?: number; isExecuting?: boolean; stopped?: boolean; activeStepKind?: string; summaryRef?: { current: HTMLButtonElement | null } }) {
  if (!activities.length && !isExecuting && !stopped) return null;
  const tools = activities.filter((activity) => activity.kind === "tool");
  const pending = tools.some((activity) => !("result" in activity));
  const prefix = stopped ? "已手动停止" : isExecuting || pending ? "正在执行" : elapsedSeconds ? `用时${elapsedSeconds}秒` : "本轮完成";
  const summary = executionSummary(activities);
  return <AnimatedDetails className="execution-summary" autoOpen={isExecuting} summaryRef={summaryRef} summary={<><span>{prefix}{summary ? `，${summary}` : ""}</span><img className="execution-chevron" src="/session-chevron.svg" alt="" /></>}>
    <div className="message-tool-calls">
      {activities.map((activity, index) => activity.kind !== "tool"
        ? <AnimatedDetails className={`intermediate-output ${activity.kind}`} key={`${activity.kind}-${index}`} autoOpen={isExecuting && activeStepKind === "thinking" && index === activities.length - 1 && activity.kind === "thinking"} summary={<><span className="activity-dot">·</span><span>{activity.kind === "thinking" ? "推理" : activity.kind === "summary" ? "中间摘要" : "中间内容"}</span><img className="details-chevron" src="/session-chevron.svg" alt="" /></>}><div className="activity-content"><MarkdownContent>{activity.content}</MarkdownContent></div></AnimatedDetails>
        : <AnimatedDetails className="message-tool" key={`${activity.name}-${index}`} summary={<><span className="activity-dot">·</span><span className="tool-name">{toolTitle(activity.name)}</span><span className="tool-state">{"result" in activity ? "已完成" : "调用中"}</span><img className="details-chevron" src="/session-chevron.svg" alt="" /></>}> 
          <div className="tool-detail"><div><p>参数</p><pre>{JSON.stringify(activity.arguments, null, 2)}</pre></div><div><p>工具结果</p><pre>{"result" in activity ? JSON.stringify(activity.result, null, 2) : "正在等待返回…"}</pre></div></div>
        </AnimatedDetails>) }
    </div>
  </AnimatedDetails>;
}
