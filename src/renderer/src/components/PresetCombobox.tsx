import { useEffect, useRef, useState } from "react";

export function PresetCombobox({ value, presets, onSelect }: { value: string; presets: ProviderPreset[]; onSelect: (id: string) => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const selected = presets.find((preset) => preset.id === value);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const q = query.trim().toLowerCase();
  const filtered = q ? presets.filter((preset) => `${preset.name} ${preset.id}`.toLowerCase().includes(q)) : presets;
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!boxRef.current?.contains(event.target as Node)) setOpen(false); };
    const closeScroll = () => setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", closeScroll, true);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("scroll", closeScroll, true); };
  }, [open]);
  const openOptions = () => {
    const el = boxRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const height = below >= 120 ? Math.min(260, below) : above >= 120 ? Math.min(260, above) : Math.max(60, Math.min(260, below));
      setPos({ top: below >= 120 ? rect.bottom + 4 : rect.top - 4 - height, left: rect.left, width: rect.width, height });
    }
    setOpen(true);
  };
  const choose = (id: string) => { onSelect(id); setOpen(false); setQuery(""); };
  const display = query || selected?.name || (value === "custom" ? "自定义" : value || "");
  return <div className="preset-combobox" ref={boxRef}><input value={display} placeholder="搜索提供商预设" onFocus={openOptions} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); setQuery(""); } if (event.key === "Enter" && filtered[0]) choose(filtered[0].id); }} /><button type="button" className="preset-combobox-toggle" onClick={() => { if (open) setOpen(false); else openOptions(); }}>⌄</button>{open && pos && <div className="preset-combobox-options" style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.height, zIndex: 200 }}><button type="button" onClick={() => choose("custom")}>自定义</button>{filtered.map((preset) => <button type="button" key={preset.id} onClick={() => choose(preset.id)}><strong>{preset.name}</strong><small>{preset.id}</small></button>)}{q !== "" && filtered.length === 0 && <span className="preset-combobox-empty">没有匹配的预设</span>}</div>}</div>;
}
