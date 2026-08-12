---
name: math-visualization
description: 讲解数学、推导公式，或绘制 2D/3D 数学图示时读取；规定 Mafs、R3F 以及教材式 MathDiagram 组件 DSL 的精确输出格式。
---

# 数学讲解与图示

讲解数学关系时，先读取本 Skill。图示必须表达推导中的对应关系、变形过程和尺寸，而不是只放一个装饰性的立体。

## 总规则

- 有清晰可视化关系时，在最终正文实际输出图示标签。
- 普通 2D 函数、坐标和几何图使用 `<Mafs>...</Mafs>`。
- 可旋转的真实 3D 空间结构使用 `<R3F>...</R3F>`。
- 教材式的“圆柱切片并重排为近似长方体”必须使用 `<MathDiagram>` 组件 DSL。
- 标签内容必须是规定格式；不要输出 JSX 代码块、JavaScript、HTML、SVG 或自由路径坐标。
- 不要输出 `<br>` 或 `<div style=...>`，使用 Markdown 空行和列表。

## MathDiagram 组件 DSL

圆柱体积推导必须使用以下受限组件：

```xml
<MathDiagram>
<CylinderVolumeProof radius="5" height="20" slices="12" showRadius showHeight showCorrespondence showArrow animate />
</MathDiagram>
```

只允许组件名 `CylinderVolumeProof`，只允许这些属性：

- `radius`：圆柱底面半径，数字；
- `height`：圆柱高，数字；
- `slices`：切片数量，最少 8，通常 12；
- `showRadius`、`showHeight`、`showCorrespondence`、`showArrow`、`animate`：布尔属性。

前端会确定性绘制圆柱顶部椭圆、径向切片、转换箭头、交错排列的近似长方体，以及 `r`、`h`、`2πr`、`πr` 和体积公式。模型只提供参数，不得生成 `<svg>`、`<path>`、`<polygon>`、事件处理器、函数或 import，也不得自行计算像素坐标。

必须在正文中说明：圆周长的一半 `½C = πr` 对应近似长方体的水平长度，圆柱高 `h` 对应长方体竖直高度，半径 `r` 对应长方体斜向宽度，因此长方体尺寸为 `πr × h × r`，体积 `πr²h = πr × r × h`。

## Mafs 精确格式（2D）

`<Mafs>` 内必须是一个普通 JSON 对象，不能多转义一层。属性名和字符串使用普通双引号 `"`，严禁写成 `\\"`。

支持字段：`height`、`width`、`pan`、`zoom`、`viewBox`、`coordinates`、`plots`。

`plots` 支持：

- `function`：`expression`、`domain`、`color`；表达式变量只使用 `x`；
- `point`：`x`、`y`；
- `circle`：`x`、`y`、`radius`；
- `segment`：`start:[x,y]`、`end:[x,y]`；
- `polygon`：`points:[[x,y],...]`；
- `rect`：`x`、`y`、`width`、`height`；
- `text`：`x`、`y`、`text`。

不要用不规则 `polygon` 冒充圆的扇形重排。圆柱体积推导使用 MathDiagram DSL。

## R3F 精确格式（3D）

`<R3F>` 内必须是一个普通 JSON 场景对象。支持 `camera`、`controls`、`grid`、`objects` 和 `background`。

`objects` 支持 `box`、`sphere`、`cylinder`、`cone`、`line`、`circle`、`dimension`、`text`。每个 3D 图至少包含可见几何体、合理的相机位置和尺寸标注；不要只输出空的 `objects` 数组，也不要只用一个圆柱和圆锥代替等积变形推导。

## 选型

- `y=sin(x)`、圆、半径、平面几何：Mafs；
- 需要拖动旋转的立体：R3F；
- 圆柱体积“切片 → 交错排列 → 近似长方体”：MathDiagram 的 `CylinderVolumeProof`。
