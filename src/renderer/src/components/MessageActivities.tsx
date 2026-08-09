import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AnimatedDetails } from "./AnimatedDetails.js";
import { toolTitle } from "../utils.js";

export function MessageActivities({ activities, elapsedSeconds, isExecuting = false, stopped = false, activeStepKind, summaryRef }: { activities: AssistantActivity[]; elapsedSeconds?: number; isExecuting?: boolean; stopped?: boolean; activeStepKind?: string; summaryRef?: { current: HTMLButtonElement | null } }) {
  if (!activities.length && !isExecuting && !stopped) return null;
  const toolCount = activities.filter((activity) => activity.kind === "tool").length;
  const pending = activities.some((activity) => activity.kind === "tool" && !("result" in activity));
  const toolCountLabel = toolCount === 1 ? "一个" : `${toolCount}`;
  return <AnimatedDetails className="execution-summary" autoOpen={isExecuting} summaryRef={summaryRef} summary={<><span>{stopped ? "已手动停止" : isExecuting || pending ? "正在执行" : elapsedSeconds ? `用时${elapsedSeconds}秒` : "本轮完成"}，共调用了{toolCountLabel}个工具</span><img className="execution-chevron" src="/session-chevron.svg" alt="" /></>}>
    <div className="message-tool-calls">
      {activities.map((activity, index) => activity.kind !== "tool"
        ? <AnimatedDetails className={`intermediate-output ${activity.kind}`} key={`${activity.kind}-${index}`} autoOpen={isExecuting && activeStepKind === "thinking" && index === activities.length - 1 && activity.kind === "thinking"} summary={<><span className="activity-dot">·</span><span>{activity.kind === "thinking" ? "推理" : activity.kind === "summary" ? "中间摘要" : "中间内容"}</span><img className="details-chevron" src="/session-chevron.svg" alt="" /></>}><div className="activity-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{activity.content}</ReactMarkdown></div></AnimatedDetails>
        : <AnimatedDetails className="message-tool" key={`${activity.name}-${index}`} summary={<><span className="activity-dot">·</span><span className="tool-name">{toolTitle(activity.name)}</span><span className="tool-state">{"result" in activity ? "已完成" : "调用中"}</span><img className="details-chevron" src="/session-chevron.svg" alt="" /></>}>
          <div className="tool-detail"><div><p>参数</p><pre>{JSON.stringify(activity.arguments, null, 2)}</pre></div><div><p>工具结果</p><pre>{"result" in activity ? JSON.stringify(activity.result, null, 2) : "正在等待返回…"}</pre></div></div>
        </AnimatedDetails>)}
    </div>
  </AnimatedDetails>;
}
