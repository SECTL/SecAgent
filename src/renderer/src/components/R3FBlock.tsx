import { Canvas } from "@react-three/fiber";
import { ContactShadows, Grid, Line, OrbitControls, Text } from "@react-three/drei";
import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { useThree } from "@react-three/fiber";

type Vec3 = [number, number, number];
type R3FSpec = {
  height?: number;
  background?: string;
  camera?: { position?: Vec3; target?: Vec3; fov?: number; near?: number; far?: number };
  controls?: boolean | { autoRotate?: boolean; autoRotateSpeed?: number; enablePan?: boolean; enableZoom?: boolean };
  grid?: boolean | { size?: number; divisions?: number; color?: string; fadeDistance?: number };
  shadows?: boolean;
  objects?: Array<Record<string, unknown>>;
};

function vec3(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) return fallback;
  const result: Vec3 = [Number(value[0]), Number(value[1]), Number(value[2])];
  return result.every(Number.isFinite) ? result : fallback;
}

function Material({ object }: { object: Record<string, unknown> }) {
  const color = typeof object.color === "string" ? object.color : "#6699cc";
  const opacity = typeof object.opacity === "number" ? object.opacity : 1;
  return <meshStandardMaterial color={color} opacity={opacity} transparent={opacity < 1} wireframe={object.wireframe === true} roughness={typeof object.roughness === "number" ? object.roughness : .6} metalness={typeof object.metalness === "number" ? object.metalness : .05} />;
}

function Dimension({ object }: { object: Record<string, unknown> }) {
  const start = vec3(object.start, [0, 0, 0]);
  const end = vec3(object.end, [1, 0, 0]);
  const midpoint: Vec3 = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2];
  const color = typeof object.color === "string" ? object.color : "#334155";
  return <group><Line points={[start, end]} color={color} lineWidth={Number(object.lineWidth ?? 1.5)} /><Text position={midpoint} color={color} fontSize={Number(object.fontSize ?? .24)} anchorX="center" anchorY="middle" rotation={vec3(object.labelRotation, [0, 0, 0])}>{String(object.label ?? object.text ?? "")}</Text></group>;
}

function CircleGuide({ object }: { object: Record<string, unknown> }) {
  const center = vec3(object.center ?? object.position, [0, 0, 0]);
  const radius = Number(object.radius ?? 1);
  const segments = Math.max(12, Math.min(128, Number(object.segments ?? 48)));
  const points = Array.from({ length: segments + 1 }, (_, index) => {
    const angle = (index / segments) * Math.PI * 2;
    return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius, center[2]] as Vec3;
  });
  return <Line points={points} color={typeof object.color === "string" ? object.color : "#334155"} lineWidth={Number(object.lineWidth ?? 1.5)} />;
}

function R3FObject({ object, index }: { object: Record<string, unknown>; index: number }) {
  const type = typeof object.type === "string" ? object.type.toLowerCase() : "box";
  const position = vec3(object.position, [0, 0, 0]);
  const rotation = vec3(object.rotation, [0, 0, 0]);
  const scale = vec3(object.scale, [1, 1, 1]);
  const color = typeof object.color === "string" ? object.color : "#6699cc";
  const common = { position, rotation, scale, castShadow: true, receiveShadow: true };
  if (type === "grid") return <Grid key={index} {...common} args={[Number(object.size ?? 10), Number(object.divisions ?? 10)]} cellColor={color} sectionColor={typeof object.sectionColor === "string" ? object.sectionColor : color} fadeDistance={Number(object.fadeDistance ?? 20)} />;
  if (type === "dimension" || type === "measure") return <Dimension key={index} object={object} />;
  if (type === "circle") return <CircleGuide key={index} object={object} />;
  if (type === "line") {
    const rawPoints = Array.isArray(object.points) ? object.points : (Array.isArray(object.start) && Array.isArray(object.end) ? [object.start, object.end] : []);
    const points = rawPoints.map((point) => vec3(point, [Number.NaN, Number.NaN, Number.NaN])).filter((point) => point.every(Number.isFinite));
    if (points.length < 2) return null;
    return <Line key={index} {...common} points={points} color={color} lineWidth={Number(object.lineWidth ?? 2)} />;
  }
  if (type === "text") return <Text key={index} {...common} color={color} fontSize={Number(object.fontSize ?? .35)} anchorX="center" anchorY="middle">{String(object.text ?? object.content ?? "")}</Text>;
  if (type === "sphere") return <mesh key={index} {...common}><sphereGeometry args={[Number(object.radius ?? 1), Number(object.widthSegments ?? 32), Number(object.heightSegments ?? 16)]} /><Material object={object} /></mesh>;
  if (type === "cylinder" || type === "cone") {
    const radius = Number(object.radius ?? 1);
    return <mesh key={index} {...common}><cylinderGeometry args={[Number(object.radiusTop ?? (type === "cone" ? 0 : radius)), Number(object.radiusBottom ?? radius), Number(object.height ?? 2), Number(object.radialSegments ?? 32)]} /><Material object={object} /></mesh>;
  }
  if (type === "torus") return <mesh key={index} {...common}><torusGeometry args={[Number(object.radius ?? 1), Number(object.tube ?? .25), Number(object.radialSegments ?? 24), Number(object.tubularSegments ?? 48)]} /><Material object={object} /></mesh>;
  if (type === "plane") return <mesh key={index} {...common}><planeGeometry args={[Number(object.width ?? 4), Number(object.height ?? 4)]} /><Material object={object} /></mesh>;
  return <mesh key={index} {...common}><boxGeometry args={[Number(object.width ?? 1), Number(object.height ?? 1), Number(object.depth ?? 1)]} /><Material object={object} /></mesh>;
}

class R3FErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("[R3F] 场景渲染失败", error, info); }
  render() { return this.state.error ? <div className="r3f-error">R3F 图示渲染失败：{this.state.error.message}</div> : this.props.children; }
}

function CameraTarget({ target }: { target: Vec3 }) {
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    camera.lookAt(...target);
    camera.updateProjectionMatrix();
  }, [camera, target]);
  return null;
}

function Scene({ spec }: { spec: R3FSpec }) {
  const camera = spec.camera || {};
  const grid = spec.grid;
  const target = vec3(camera.target, [0, 0, 0]);
  const controls = typeof spec.controls === "object" ? spec.controls : {};
  return <>
    <CameraTarget target={target} />
    <color attach="background" args={[spec.background ?? "#f8fafc"]} />
    <ambientLight intensity={.7} />
    <directionalLight position={[4, 6, 5]} intensity={1.4} castShadow />
    {grid !== false && <Grid args={[Number(typeof grid === "object" ? grid.size ?? 10 : 10), Number(typeof grid === "object" ? grid.divisions ?? 10 : 10)]} cellColor={typeof grid === "object" && grid.color ? grid.color : "#cbd5e1"} sectionColor={typeof grid === "object" && grid.color ? grid.color : "#94a3b8"} fadeDistance={Number(typeof grid === "object" ? grid.fadeDistance ?? 20 : 20)} />}
    {(spec.objects || []).map((object, index) => <R3FObject key={index} object={object} index={index} />)}
    {spec.shadows !== false && <ContactShadows position={[0, -1.01, 0]} opacity={.3} scale={12} blur={2.5} far={4} />}
    {spec.controls !== false && <OrbitControls makeDefault enableDamping target={target} autoRotate={controls.autoRotate ?? false} autoRotateSpeed={controls.autoRotateSpeed ?? 2} enablePan={controls.enablePan ?? true} enableZoom={controls.enableZoom ?? true} />}
  </>;
}

export function R3FBlock({ source }: { source: string }) {
  try {
    const spec = parseVisualizationJson(source) as R3FSpec;
    return <div className="r3f-block" role="img" aria-label="三维交互图示"><R3FErrorBoundary><Canvas shadows={spec.shadows !== false} dpr={[1, 2]} camera={{ position: spec.camera?.position ?? [4, 3, 5], fov: spec.camera?.fov ?? 45, near: spec.camera?.near ?? .1, far: spec.camera?.far ?? 100 }} fallback={<div className="r3f-error">当前环境不支持 WebGL 三维渲染。</div>}>
      <Scene spec={spec} />
    </Canvas></R3FErrorBoundary><div className="r3f-hint">拖动旋转 · 滚轮缩放 · 右键平移</div></div>;
  } catch (error) {
    return <pre className="r3f-error">R3F 图示解析失败：{error instanceof Error ? error.message : String(error)}</pre>;
  }
}

/** Be tolerant of an extra escaping layer occasionally emitted inside <R3F>. */
function parseVisualizationJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (firstError) {
    const normalized = source.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (normalized === source) throw firstError;
    return JSON.parse(normalized);
  }
}
