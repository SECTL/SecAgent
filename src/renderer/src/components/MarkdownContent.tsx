import { useEffect, useRef, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import mermaid from "mermaid";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Circle, Coordinates, Line, Mafs, Plot, Point, Polygon, Text as MafsText, Vector } from "mafs";
import "mafs/core.css";
import "katex/dist/katex.min.css";
import { R3FBlock } from "./R3FBlock.js";
import { CylinderVolumeProof, parseMathDiagramAttributes } from "./MathDiagram.js";

let mermaidId = 0;

type MarkdownCodeProps = ComponentProps<"code"> & { inline?: boolean };

function MermaidBlock({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(`mermaid-diagram-${++mermaidId}`);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    container.textContent = "正在渲染图表…";
    container.classList.remove("mermaid-error");
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
    void mermaid.render(idRef.current, chart).then(({ svg, bindFunctions }) => {
      if (cancelled || !containerRef.current) return;
      containerRef.current.innerHTML = svg;
      bindFunctions?.(containerRef.current);
    }).catch((error: unknown) => {
      if (cancelled || !containerRef.current) return;
      containerRef.current.textContent = `Mermaid 图表渲染失败：${error instanceof Error ? error.message : String(error)}`;
      containerRef.current.classList.add("mermaid-error");
    });

    return () => {
      cancelled = true;
    };
  }, [chart]);

  return <div ref={containerRef} className="mermaid-block" role="img" aria-label="Mermaid 图表" />;
}

function MarkdownCode({ inline, className, children, ...props }: MarkdownCodeProps) {
  const language = /language-(\w+)/.exec(className || "")?.[1];
  const chart = String(children).replace(/\n$/, "");
  if (!inline && language === "mermaid") return <MermaidBlock chart={chart} />;
  if (!inline && language === "mafs") return <MafsBlock source={chart} />;
  if (!inline && language === "r3f") return <R3FBlock source={chart} />;
  if (!inline && language === "mathdiagram") return <MathDiagramBlock source={chart} />;
  return <code className={className} {...props}>{children}</code>;
}

type MafsSpec = {
  width?: number | "auto";
  height?: number;
  pan?: boolean;
  zoom?: boolean;
  viewBox?: { x?: [number, number]; y?: [number, number]; padding?: number };
  coordinates?: boolean | { subdivisions?: number | false };
  plots?: Array<Record<string, unknown>>;
};

const expressionNames = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "sqrt", "abs", "log", "exp", "min", "max", "floor", "ceil", "pi", "e"]);

function compileExpression(source: unknown): ((value: number) => number) | null {
  if (typeof source !== "string" || !source.trim()) return null;
  const names = source.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  if (names.some((name) => name !== "x" && !expressionNames.has(name))) return null;
  if (!/^[\d\s+\-*/%^().,_A-Za-z]+$/.test(source)) return null;
  const expression = source.replace(/\^/g, "**").replace(/\bpi\b/g, "Math.PI").replace(/\be\b/g, "Math.E").replace(/\b(sin|cos|tan|asin|acos|atan|sqrt|abs|log|exp|min|max|floor|ceil)\b/g, "Math.$1");
  try {
    // The expression is restricted to numbers, x, approved Math functions and operators above.
    const fn = new Function("x", `"use strict"; return (${expression});`) as (value: number) => unknown;
    return (value) => {
      const result = fn(value);
      return typeof result === "number" && Number.isFinite(result) ? result : Number.NaN;
    };
  } catch {
    return null;
  }
}

function MafsPlot({ plot, index }: { plot: Record<string, unknown>; index: number }) {
  const type = typeof plot.type === "string" ? plot.type : "function";
  const color = typeof plot.color === "string" ? plot.color : (typeof plot.stroke === "string" ? plot.stroke : undefined);
  if (type === "disk-rearrangement" || type === "diskRearrangement") return <DiskRearrangement key={index} plot={plot} />;
  if (type === "function" || type === "ofX") {
    const fn = compileExpression(plot.expression ?? plot.formula ?? plot.y);
    const domain: [number, number] = Array.isArray(plot.domain) && plot.domain.length === 2 ? [Number(plot.domain[0]), Number(plot.domain[1])] : [-5, 5];
    return fn ? <Plot.OfX key={index} y={fn} domain={domain} color={color} /> : null;
  }
  if (type === "point") return <Point key={index} x={Number(plot.x)} y={Number(plot.y)} color={color} />;
  if (type === "circle") return <Circle key={index} center={[Number(plot.x ?? 0), Number(plot.y ?? 0)]} radius={Number(plot.radius ?? 1)} color={color} fillOpacity={Number(plot.fillOpacity ?? 0)} />;
  if (type === "segment" || type === "line") {
    const start = Array.isArray(plot.start) ? plot.start : [plot.x1, plot.y1];
    const end = Array.isArray(plot.end) ? plot.end : [plot.x2, plot.y2];
    return <Line.Segment key={index} point1={[Number(start[0]), Number(start[1])]} point2={[Number(end[0]), Number(end[1])]} color={color} weight={typeof plot.strokeWidth === "number" ? plot.strokeWidth : undefined} />;
  }
  if (type === "vector") return <Vector key={index} tail={[Number(plot.x ?? 0), Number(plot.y ?? 0)]} tip={[Number(plot.toX ?? plot.x2), Number(plot.toY ?? plot.y2)]} color={color} />;
  if (type === "polygon" || type === "rect") {
    const points: Array<[number, number]> = type === "rect"
      ? [[Number(plot.x ?? 0), Number(plot.y ?? 0)], [Number(plot.x ?? 0) + Number(plot.width ?? 1), Number(plot.y ?? 0)], [Number(plot.x ?? 0) + Number(plot.width ?? 1), Number(plot.y ?? 0) + Number(plot.height ?? 1)], [Number(plot.x ?? 0), Number(plot.y ?? 0) + Number(plot.height ?? 1)]]
      : parsePoints(plot.points);
    if (points.length < 3) return null;
    const fill = typeof plot.fill === "string" ? plot.fill : undefined;
    return <Polygon key={index} points={points} color={color} fillOpacity={Number(plot.fillOpacity ?? plot.opacity ?? (fill ? .35 : 0))} svgPolygonProps={{ ...(fill ? { fill } : {}), ...(typeof plot.strokeWidth === "number" ? { strokeWidth: plot.strokeWidth } : {}) }} />;
  }
  if (type === "text") {
    const position = Array.isArray(plot.position) ? plot.position : [plot.x, plot.y];
    return <MafsText key={index} x={Number(position[0])} y={Number(position[1])} color={color} size={Number(plot.size ?? plot.fontSize ?? 16) / 16}>{String(plot.text ?? plot.content ?? "")}</MafsText>;
  }
  return null;
}

/**
 * Semantic teaching primitive for the disk -> approximate rectangle proof.
 * The model supplies intent; the renderer owns all geometry and correspondence.
 */
function DiskRearrangement({ plot }: { plot: Record<string, unknown> }) {
  const radius = Math.max(.5, Number(plot.radius ?? 2));
  const slices = Math.max(8, Math.min(24, Math.round(Number(plot.slices ?? 12))));
  const centerX = Number(plot.centerX ?? -4);
  const centerY = Number(plot.centerY ?? 0);
  const rectangleX = Number(plot.rectangleX ?? 1);
  const width = Math.PI * radius;
  const stripWidth = width / slices;
  const sectorColor = typeof plot.sectorColor === "string" ? plot.sectorColor : "#2563eb";
  const rearrangedColor = typeof plot.rearrangedColor === "string" ? plot.rearrangedColor : "#f59e0b";
  const sectors = Array.from({ length: slices }, (_, index) => {
    const start = (index / slices) * Math.PI * 2;
    const end = ((index + 1) / slices) * Math.PI * 2;
    const arc = Array.from({ length: 4 }, (_, pointIndex) => {
      const angle = start + ((end - start) * pointIndex) / 3;
      return [centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius] as [number, number];
    });
    return <Polygon key={`sector-${index}`} points={[[centerX, centerY], ...arc]} color={sectorColor} fillOpacity={.32} />;
  });
  const strips = Array.from({ length: slices }, (_, index) => {
    const x0 = rectangleX + index * stripWidth;
    const x1 = x0 + stripWidth;
    // The alternating colors show the interleaving while every strip keeps
    // the same height r, so the resulting rectangle has dimensions πr × r.
    const points: Array<[number, number]> = [[x0, -radius / 2], [x1, -radius / 2], [x1, radius / 2], [x0, radius / 2]];
    return <Polygon key={`strip-${index}`} points={points} color={index % 2 === 0 ? rearrangedColor : "#d97706"} fillOpacity={.42} />;
  });
  return <>
    {sectors}
    <Circle center={[centerX, centerY]} radius={radius} color={sectorColor} fillOpacity={0} />
    {strips}
    <Line.Segment point1={[rectangleX, 0]} point2={[rectangleX + width, 0]} color={rearrangedColor} weight={2} />
    <MafsText x={centerX} y={-radius - .55} color={sectorColor} size={.85}>圆：周长 2πr</MafsText>
    <MafsText x={centerX} y={radius + .45} color={sectorColor} size={.85}>切成 {slices} 个扇形</MafsText>
    <MafsText x={rectangleX + width / 2} y={radius + .45} color={rearrangedColor} size={.85}>交错排列：底边 ≈ πr，高 = r</MafsText>
    <MafsText x={rectangleX + width / 2} y={-radius - .55} color={rearrangedColor} size={.85}>πr × r = πr²</MafsText>
  </>;
}

function parsePoints(value: unknown): Array<[number, number]> {
  if (Array.isArray(value)) return value.filter((point): point is [number, number] => Array.isArray(point) && point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))).map((point) => [Number(point[0]), Number(point[1])]);
  if (typeof value !== "string") return [];
  const numbers = value.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
  const points: Array<[number, number]> = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) points.push([numbers[index], numbers[index + 1]]);
  return points;
}

function MafsBlock({ source }: { source: string }) {
  try {
    const spec = parseVisualizationJson(source) as MafsSpec;
    const viewBox = spec.viewBox ? { x: spec.viewBox.x, y: spec.viewBox.y, padding: spec.viewBox.padding } : undefined;
    return <div className="mafs-block" role="img" aria-label="数学图示"><Mafs width={spec.width ?? "auto"} height={spec.height ?? 280} pan={spec.pan ?? true} zoom={spec.zoom ?? true} viewBox={viewBox}>
      {spec.coordinates !== false && <Coordinates.Cartesian subdivisions={typeof spec.coordinates === "object" ? spec.coordinates.subdivisions : undefined} />}
      {(spec.plots || []).map((plot, index) => <MafsPlot key={index} plot={plot} index={index} />)}
    </Mafs></div>;
  } catch (error) {
    return <pre className="mafs-error">Mafs 图示解析失败：{error instanceof Error ? error.message : String(error)}</pre>;
  }
}

/** Accept model output that incorrectly escaped an already-delimited JSON block. */
function parseVisualizationJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (firstError) {
    const normalized = source.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (normalized === source) throw firstError;
    return JSON.parse(normalized);
  }
}

function MathDiagramBlock({ source }: { source: string }) {
  const props = parseMathDiagramAttributes(source);
  return props ? <CylinderVolumeProof {...props} /> : <pre className="math-diagram-error">不支持的数学图示组件。当前支持 CylinderVolumeProof。</pre>;
}

function expandMafsTags(markdown: string): string {
  const expanded = markdown
    .replace(/<Mafs\b[^>]*>([\s\S]*?)<\/Mafs>/gi, (_, source: string) => `\n\n\`\`\`mafs\n${source.trim()}\n\`\`\`\n\n`)
    .replace(/<R3F\b[^>]*>([\s\S]*?)<\/R3F>/gi, (_, source: string) => `\n\n\`\`\`r3f\n${source.trim()}\n\`\`\`\n\n`)
    .replace(/<MathDiagram\b[^>]*>([\s\S]*?)<\/MathDiagram>/gi, (_, source: string) => `\n\n\`\`\`mathdiagram\n${source.trim()}\n\`\`\`\n\n`);
  return expanded.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?div\b[^>]*>/gi, "\n");
}

export function MarkdownContent({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{ code: MarkdownCode }}>{expandMafsTags(children)}</ReactMarkdown>;
}
