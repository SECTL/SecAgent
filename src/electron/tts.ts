import { EdgeTTS } from "@andresaya/edge-tts";
import { DEFAULT_TTS_RATE, DEFAULT_TTS_VOICE } from "../config.js";

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Generate one short MP3 chunk so the renderer can start playback immediately. */
export async function synthesizeSpeech(text: string, options: { voice?: string; rate?: string } = {}): Promise<Buffer> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return Buffer.alloc(0);
  let lastError: unknown;
  // Edge TTS occasionally resets the TLS socket before the WebSocket
  // handshake completes. A fresh client per attempt avoids reusing that
  // broken connection and makes short-lived network hiccups transparent.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const client = new EdgeTTS();
      await client.synthesize(escapeXml(clean), options.voice || DEFAULT_TTS_VOICE, { rate: options.rate || DEFAULT_TTS_RATE, outputFormat: "audio-24khz-48kbitrate-mono-mp3" });
      return client.toBuffer();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
