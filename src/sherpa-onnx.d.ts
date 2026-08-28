declare module "sherpa-onnx" {
  export function createKws(config: unknown): {
    createStream(): {
      acceptWaveform(sampleRate: number, samples: Float32Array): void;
      inputFinished(): void;
      free(): void;
      handle: unknown;
    };
    isReady(stream: unknown): boolean;
    decode(stream: unknown): void;
    getResult(stream: unknown): { keyword?: string; [key: string]: unknown };
    reset(stream: unknown): void;
    free(): void;
  };
  export function createOnlineRecognizer(config: unknown): {
    createStream(): {
      acceptWaveform(sampleRate: number, samples: Float32Array): void;
      inputFinished(): void;
      free(): void;
      handle: unknown;
    };
    isReady(stream: unknown): boolean;
    decode(stream: unknown): void;
    isEndpoint(stream: unknown): boolean;
    reset(stream: unknown): void;
    getResult(stream: unknown): { text?: string; [key: string]: unknown };
    free(): void;
  };
}
