declare module "sherpa-onnx" {
  export function createKws(config: unknown): {
    createStream(): {
      acceptWaveform(sampleRate: number, samples: Float32Array): void;
      inputFinished(): void;
      handle: unknown;
    };
    isReady(stream: unknown): boolean;
    decode(stream: unknown): void;
    getResult(stream: unknown): { keyword?: string; [key: string]: unknown };
    reset(stream: unknown): void;
    free(): void;
  };
}
