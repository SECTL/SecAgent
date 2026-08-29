import { useEffect, useRef, useState } from "react";

export interface SelectOption { value: string; label: string }

/**
 * A styled replacement for native <select>. Chromium cannot restyle the
 * built-in dropdown popup, so the expanded list is rendered manually with the
 * same positioning strategy as PresetCombobox (fixed panel, flips above/below).
 */
export function SelectCombobox({ value, options, onChange, disabled, ariaLabel }: { value: string; options: SelectOption[]; onChange: (value: string) => void; disabled?: boolean; ariaLabel?: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));
  const selected = options.find((option) => option.value === value);

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
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const height = below >= 140 ? Math.min(280, below) : above >= 140 ? Math.min(280, above) : Math.max(60, Math.min(280, below));
    setPos({ top: below >= 140 ? rect.bottom + 4 : rect.top - 4 - height, left: rect.left, width: rect.width, height });
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  };

  const choose = (option: SelectOption) => {
    onChange(option.value);
    setOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { setOpen(false); return; }
    if (!open) {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openOptions(); }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => {
        const next = event.key === "ArrowDown" ? current + 1 : current - 1;
        return next < 0 ? options.length - 1 : next >= options.length ? 0 : next;
      });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) choose(option);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
    }
  };

  return <div className={`select-combobox ${disabled ? "disabled" : ""}`} ref={boxRef} onKeyDown={handleKeyDown}>
    <button type="button" className="select-combobox-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} disabled={disabled} onClick={() => (open ? setOpen(false) : openOptions())}>
      <span className="select-combobox-value">{selected?.label || value || "—"}</span>
      <span className="select-combobox-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && pos && <div className="select-combobox-options" style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.height, zIndex: 200 }} role="listbox">
      {options.map((option, index) => <button type="button" role="option" aria-selected={option.value === value} key={option.value} className={`select-combobox-option ${option.value === value ? "selected" : ""} ${index === activeIndex ? "active" : ""}`} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(option)}>{option.label}</button>)}
      {options.length === 0 && <span className="select-combobox-empty">暂无选项</span>}
    </div>}
  </div>;
}
