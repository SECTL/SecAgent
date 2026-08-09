import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WAKE_HOTKEY, displayWakeHotkey, normalizeWakeHotkey, wakeHotkeyFromKeyboardEvent } from "./wake-hotkey.js";

test("normalizes the default wake shortcut", () => {
  assert.equal(normalizeWakeHotkey(DEFAULT_WAKE_HOTKEY), "Ctrl+Alt+A");
  assert.equal(displayWakeHotkey(DEFAULT_WAKE_HOTKEY, "win32"), "Ctrl Alt A");
  assert.equal(displayWakeHotkey(DEFAULT_WAKE_HOTKEY, "darwin"), "Ctrl Option A");
});

test("rejects shortcuts without modifiers or a final key", () => {
  assert.throws(() => normalizeWakeHotkey("A"));
  assert.throws(() => normalizeWakeHotkey("Ctrl+Unknown"));
});

test("captures keyboard events using physical key codes", () => {
  assert.equal(wakeHotkeyFromKeyboardEvent({ key: "å", code: "KeyA", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }), "Ctrl+Alt+A");
});
