import { useEffect } from "react";

/** Invisible microphone capture window used while voice wake is enabled. */
export function VoiceWakeListener() {
  useEffect(() => {
    let context: AudioContext | undefined;
    let stream: MediaStream | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let processor: ScriptProcessorNode | undefined;
    let stopped = false;
    const phrase = new URLSearchParams(window.location.search).get("phrase") || "小泽同学";
    let audioFrames = 0;
    let lastHeartbeatAt = 0;
    const log = (stage: string, data: Record<string, unknown> = {}) => {
      const payload = { stage, ...data };
      console.info("[voice-wake] renderer", payload);
      window.secagent.logVoiceWake(payload);
    };
    const removeResume = window.secagent.onVoiceWakeResume(() => {
      void (async () => {
        log("resume.received", { contextState: context?.state || "uninitialized", liveTracks: stream?.getAudioTracks().filter((track) => track.readyState === "live").length || 0 });
        try {
          await window.secagent.startVoiceWake(phrase);
          if (context && context.state !== "running") await context.resume();
          log("resume.completed", { contextState: context?.state || "uninitialized" });
        } catch (error) {
          log("resume.failed", { error: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
    void (async () => {
      try {
        log("capture.starting", { phrase });
        await window.secagent.startVoiceWake(phrase);
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (stopped) return;
        context = new AudioContext({ sampleRate: 16000 });
        context.onstatechange = () => log("audio-context.state", { state: context?.state || "closed" });
        if (context.state !== "running") await context.resume();
        source = context.createMediaStreamSource(stream);
        processor = context.createScriptProcessor(2048, 1, 1);
        processor.onaudioprocess = (event) => {
          audioFrames += 1;
          const now = Date.now();
          if (audioFrames === 1 || now - lastHeartbeatAt >= 15000) {
            lastHeartbeatAt = now;
            log("audio.frames", { count: audioFrames, contextState: context?.state || "closed" });
          }
          window.secagent.sendVoiceWakeAudio(new Float32Array(event.inputBuffer.getChannelData(0)));
        };
        source.connect(processor);
        processor.connect(context.destination);
        stream.getAudioTracks().forEach((track) => track.addEventListener("ended", () => log("audio-track.ended", { label: track.label })));
        log("capture.ready", { contextState: context.state, tracks: stream.getAudioTracks().length, phrase });
      } catch (error) {
        log("capture.failed", { error: error instanceof Error ? error.message : String(error) });
        await window.secagent.stopVoiceWake();
      }
    })();
    return () => {
      stopped = true;
      log("capture.stopping", { audioFrames, contextState: context?.state || "uninitialized" });
      processor?.disconnect();
      source?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
      void window.secagent.stopVoiceWake();
      removeResume();
    };
  }, []);
  return null;
}
