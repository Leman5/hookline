/// <reference lib="webworker" />
import { analyze } from './analyze.ts';

export interface AnalyzeRequest {
  id: number;
  pcm: Float32Array;
  sampleRate: number;
}

self.onmessage = (e: MessageEvent<AnalyzeRequest>) => {
  const { id, pcm, sampleRate } = e.data;
  try {
    const result = analyze(pcm, sampleRate);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
