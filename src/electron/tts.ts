import { EdgeTTS } from "@andresaya/edge-tts";
import { DEFAULT_TTS_RATE, DEFAULT_TTS_VOICE } from "../config.js";

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Generate one short MP3 chunk so the renderer can start playback immediately. */
export async function synthesizeSpeech(text: string, options: { voice?: string; rate?: string } = {}): Promise<Buffer> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return Buffer.alloc(0);
  const client = new EdgeTTS();
  await client.synthesize(escapeXml(clean), options.voice || DEFAULT_TTS_VOICE, { rate: options.rate || DEFAULT_TTS_RATE, outputFormat: "audio-24khz-48kbitrate-mono-mp3" });
  return client.toBuffer();
}
