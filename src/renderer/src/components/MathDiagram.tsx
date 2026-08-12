import { useMemo } from "react";

export type CylinderVolumeProofProps = {
  radius?: number;
  height?: number;
  slices?: number;
  showRadius?: boolean;
  showHeight?: boolean;
  showCorrespondence?: boolean;
  showArrow?: boolean;
  animate?: boolean;
};

function num(value: unknown, fallback: number) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function bool(value: unknown, fallback: boolean) {
  if (value === undefined) return fallback;
  return value === true || value === "true" || value === "1";
}

/** Deterministic textbook-style SVG for the cylinder-volume rearrangement proof. */
export function CylinderVolumeProof(props: CylinderVolumeProofProps) {
  const radius = Math.max(.5, num(props.radius, 5));
  const height = Math.max(.5, num(props.height, 20));
  const slices = Math.max(8, Math.min(24, Math.round(num(props.slices, 12))));
  const showRadius = bool(props.showRadius, true);
  const showHeight = bool(props.showHeight, true);
  const showCorrespondence = bool(props.showCorrespondence, true);
  const showArrow = bool(props.showArrow, true);
  const animate = bool(props.animate, false);

  const cylinder = { cx: 170, top: 112, bottom: 385, rx: 132, ry: 38 };
  const prism = { x: 650, y: 112, width: 360, height: 273 };
  const prismDepth = { x: 52, y: -42 };
  const sliceWidth = prism.width / slices;
  const sectorLines = useMemo(() => Array.from({ length: slices + 1 }, (_, index) => {
    const angle = Math.PI * 2 * index / slices;
    return { x: cylinder.cx + Math.cos(angle) * cylinder.rx, y: cylinder.top + Math.sin(angle) * cylinder.ry };
  }), [slices]);

  return <div className={`math-diagram-block${animate ? " math-diagram-animated" : ""}`}>
    <svg className="math-diagram-svg" viewBox="0 0 1120 520" role="img" aria-label="圆柱切片交错排列成近似长方体的体积推导图">
      <defs>
        <marker id="math-arrow-orange" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#ef6c00" /></marker>
        <marker id="math-arrow-gray" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#4b5563" /></marker>
      </defs>

      <g className="math-diagram-title">
        <text x="170" y="35" textAnchor="middle">圆柱</text>
        <text x="830" y="35" textAnchor="middle">扇形柱片交错排列后的近似长方体</text>
      </g>

      <g className="math-cylinder">
        <path d={`M ${cylinder.cx - cylinder.rx} ${cylinder.top} L ${cylinder.cx - cylinder.rx} ${cylinder.bottom} A ${cylinder.rx} ${cylinder.ry} 0 0 0 ${cylinder.cx + cylinder.rx} ${cylinder.bottom} L ${cylinder.cx + cylinder.rx} ${cylinder.top} A ${cylinder.rx} ${cylinder.ry} 0 0 0 ${cylinder.cx - cylinder.rx} ${cylinder.top}`} fill="#eef3f7" stroke="#1f2937" strokeWidth="3" />
        <ellipse cx={cylinder.cx} cy={cylinder.top} rx={cylinder.rx} ry={cylinder.ry} fill="#dbe4ec" stroke="#111827" strokeWidth="3" />
        {sectorLines.map((point, index) => <line key={index} x1={cylinder.cx} y1={cylinder.top} x2={point.x} y2={point.y} stroke="#374151" strokeWidth="1.6" />)}
        {sectorLines.slice(0, -1).map((point, index) => {
          const angle = Math.PI * 2 * index / slices;
          if (Math.sin(angle) < 0) return null;
          return <line key={`side-slice-${index}`} x1={point.x} y1={point.y} x2={point.x} y2={cylinder.bottom + Math.sin(angle) * cylinder.ry} stroke="#374151" strokeWidth="1.3" />;
        })}
        <ellipse cx={cylinder.cx} cy={cylinder.bottom} rx={cylinder.rx} ry={cylinder.ry} fill="none" stroke="#111827" strokeWidth="3" />
        {showRadius && <Dimension x1={cylinder.cx} y1={cylinder.top} x2={cylinder.cx + cylinder.rx} y2={cylinder.top} label={`半径 r = ${radius} cm`} />}
        {showHeight && <Dimension x1={cylinder.cx + cylinder.rx + 18} y1={cylinder.top} x2={cylinder.cx + cylinder.rx + 18} y2={cylinder.bottom} label={`高 h = ${height} cm`} vertical />}
        <text className="math-diagram-formula" x={cylinder.cx} y="458" textAnchor="middle">圆柱体积 = πr²h</text>
      </g>

      {showArrow && <g className="math-diagram-transform-arrow"><path d="M390 220 H485 V188 L565 250 L485 312 V280 H390 Z" fill="#fff" stroke="#4b5563" strokeWidth="2.5" markerEnd="url(#math-arrow-gray)" /><text x="478" y="345" textAnchor="middle">切片、交错排列</text></g>}

      <g className="math-prism">
        <path d={`M ${prism.x} ${prism.y} L ${prism.x + prismDepth.x} ${prism.y + prismDepth.y} L ${prism.x + prism.width + prismDepth.x} ${prism.y + prismDepth.y} L ${prism.x + prism.width} ${prism.y} Z`} fill="#fff3d6" stroke="#374151" strokeWidth="2.5" />
        <path d={`M ${prism.x + prism.width} ${prism.y} L ${prism.x + prism.width + prismDepth.x} ${prism.y + prismDepth.y} L ${prism.x + prism.width + prismDepth.x} ${prism.y + prism.height + prismDepth.y} L ${prism.x + prism.width} ${prism.y + prism.height} Z`} fill="#f7e5bd" stroke="#374151" strokeWidth="2.5" />
        {Array.from({ length: slices + 1 }, (_, index) => {
          const x = prism.x + sliceWidth * index;
          return <line key={`top-slice-${index}`} x1={x} y1={prism.y} x2={x + prismDepth.x} y2={prism.y + prismDepth.y} stroke="#374151" strokeWidth="1.35" />;
        })}
        <path d={`M ${prism.x + prismDepth.x} ${prism.y + prismDepth.y} Q ${prism.x + prismDepth.x + sliceWidth / 2} ${prism.y + prismDepth.y + 8} ${prism.x + prismDepth.x + sliceWidth} ${prism.y + prismDepth.y} ${Array.from({ length: slices - 1 }, (_, index) => `Q ${prism.x + prismDepth.x + sliceWidth * (index + 1.25)} ${prism.y + prismDepth.y - 8} ${prism.x + prismDepth.x + sliceWidth * (index + 2)} ${prism.y + prismDepth.y}`).join(" ")}`} fill="none" stroke="#374151" strokeWidth="1.7" />
        {Array.from({ length: slices }, (_, index) => {
          const x0 = prism.x + sliceWidth * index;
          const x1 = x0 + sliceWidth;
          const topCurve = prism.y + (index % 2 === 0 ? 10 : -8);
          const bottomCurve = prism.y + prism.height + (index % 2 === 0 ? -8 : 10);
          const path = `M ${x0} ${prism.y} Q ${(x0 + x1) / 2} ${topCurve} ${x1} ${prism.y} L ${x1} ${prism.y + prism.height} Q ${(x0 + x1) / 2} ${bottomCurve} ${x0} ${prism.y + prism.height} Z`;
          return <path key={index} d={path} fill={index % 2 === 0 ? "#fff7e6" : "#f9edcf"} stroke="#374151" strokeWidth="1.7" />;
        })}
        {showCorrespondence && <>
          <Dimension x1={prism.x} y1={prism.y + prism.height + 37} x2={prism.x + prism.width} y2={prism.y + prism.height + 37} label="底边 ≈ πr = ½圆周长" />
          <Dimension x1={prism.x - 25} y1={prism.y} x2={prism.x - 25} y2={prism.y + prism.height} label="高 = h" vertical />
          <Dimension x1={prism.x + prism.width} y1={prism.y} x2={prism.x + prism.width + prismDepth.x} y2={prism.y + prismDepth.y} label="宽 = r" angle={-39} />
          <text className="math-diagram-note" x={prism.x + prism.width / 2} y="458" textAnchor="middle">长方体体积 = πr × r × h = πr²h</text>
        </>}
      </g>
    </svg>
  </div>;
}

function Dimension({ x1, y1, x2, y2, label, vertical = false, angle: customAngle }: { x1: number; y1: number; x2: number; y2: number; label: string; vertical?: boolean; angle?: number }) {
  const angle = customAngle ?? (vertical ? -90 : 0);
  const tx = (x1 + x2) / 2;
  const ty = (y1 + y2) / 2;
  return <g className="math-dimension">
    <line x1={x1} y1={y1} x2={x2} y2={y2} markerStart="url(#math-arrow-orange)" markerEnd="url(#math-arrow-orange)" />
    <text x={tx} y={ty - 8} transform={`rotate(${angle} ${tx} ${ty})`} textAnchor="middle">{label}</text>
  </g>;
}

export function parseMathDiagramAttributes(source: string): CylinderVolumeProofProps | null {
  const match = source.match(/<CylinderVolumeProof\b([^>]*)\/?>(?:<\/CylinderVolumeProof>)?/i);
  if (!match) return null;
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g;
  let attribute: RegExpExecArray | null;
  while ((attribute = pattern.exec(match[1]))) attributes[attribute[1]] = attribute[2] ?? attribute[3] ?? attribute[4] ?? "true";
  return {
    radius: attributes.radius === undefined ? undefined : Number(attributes.radius),
    height: attributes.height === undefined ? undefined : Number(attributes.height),
    slices: attributes.slices === undefined ? undefined : Number(attributes.slices),
    showRadius: attributes.showRadius === undefined ? undefined : attributes.showRadius === "true",
    showHeight: attributes.showHeight === undefined ? undefined : attributes.showHeight === "true",
    showCorrespondence: attributes.showCorrespondence === undefined ? undefined : attributes.showCorrespondence === "true",
    showArrow: attributes.showArrow === undefined ? undefined : attributes.showArrow === "true",
    animate: attributes.animate === undefined ? undefined : attributes.animate === "true",
  };
}
