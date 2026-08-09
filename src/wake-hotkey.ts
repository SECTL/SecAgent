const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Super"] as const;
const MODIFIERS = new Set<string>(MODIFIER_ORDER);
const KEY_ALIASES: Record<string, string> = {
  CONTROL: "Ctrl",
  CTRL: "Ctrl",
  OPTION: "Alt",
  ALT: "Alt",
  SHIFT: "Shift",
  CMD: "Super",
  COMMAND: "Super",
  META: "Super",
  SUPER: "Super"
};

export const DEFAULT_WAKE_HOTKEY = "Ctrl+Alt+A";

function normalizeKey(value: string): string {
  const key = value.trim();
  if (/^[a-z]$/i.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return key;
  const functionKey = key.match(/^F([1-9]|1[0-9]|2[0-4])$/i);
  if (functionKey) return `F${functionKey[1]}`;
  const named = ["Space", "Tab", "Enter", "Escape", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "Up", "Down", "Left", "Right"];
  const match = named.find((item) => item.toLowerCase() === key.toLowerCase());
  if (match) return match;
  throw new Error("快捷键必须包含一个字母、数字、功能键或方向键");
}

export function normalizeWakeHotkey(value: unknown): string {
  if (typeof value !== "string") throw new Error("随时唤醒快捷键无效");
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) throw new Error("随时唤醒快捷键至少需要一个修饰键和一个按键");
  const key = normalizeKey(parts.at(-1) || "");
  const modifiers = [...new Set(parts.slice(0, -1).map((part) => KEY_ALIASES[part.toUpperCase()] || part))];
  if (!modifiers.length || modifiers.some((modifier) => !MODIFIERS.has(modifier))) throw new Error("随时唤醒快捷键包含不支持的修饰键");
  return `${MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier)).join("+")}+${key}`;
}

export function isValidWakeHotkey(value: unknown): value is string {
  try { normalizeWakeHotkey(value); return true; } catch { return false; }
}

export function displayWakeHotkey(value: string, platform: NodeJS.Platform): string {
  const normalized = normalizeWakeHotkey(value);
  if (platform !== "darwin") return normalized.replaceAll("+", " ");
  return normalized.replace("Alt", "Option").replace("Super", "Command").replaceAll("+", " ");
}

export function wakeHotkeyFromKeyboardEvent(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string | null {
  const modifiers = [event.ctrlKey ? "Ctrl" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : "", event.metaKey ? "Super" : ""].filter(Boolean);
  if (!modifiers.length || ["Control", "Alt", "Shift", "Meta", "OS", "Option", "Command"].includes(event.key)) return null;
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : event.key;
  try { return normalizeWakeHotkey([...modifiers, key].join("+")); } catch { return null; }
}
