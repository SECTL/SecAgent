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
    void (async () => {
      try {
        await window.secagent.startVoiceWake(phrase);
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (stopped) return;
        context = new AudioContext({ sampleRate: 16000 });
        source = context.createMediaStreamSource(stream);
        processor = context.createScriptProcessor(2048, 1, 1);
        processor.onaudioprocess = (event) => window.secagent.sendVoiceWakeAudio(new Float32Array(event.inputBuffer.getChannelData(0)));
        source.connect(processor);
        processor.connect(context.destination);
        console.info(`[voice-wake] listening phrase=${phrase}`);
      } catch (error) {
        console.error("[voice-wake] microphone start failed", error);
        await window.secagent.stopVoiceWake();
      }
    })();
    return () => {
      stopped = true;
      processor?.disconnect();
      source?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
      void window.secagent.stopVoiceWake();
    };
  }, []);
  return null;
}
