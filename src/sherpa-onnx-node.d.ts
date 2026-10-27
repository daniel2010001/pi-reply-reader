/** The part of sherpa-onnx-node 2.x (CommonJS, untyped) that playback.ts uses. */
declare module "sherpa-onnx-node" {
	export class GenerationConfig {
		constructor(options: {
			sid?: number;
			speed?: number;
			numSteps?: number;
			silenceScale?: number;
			extra?: Record<string, number | string>;
		});
	}

	export class OfflineTts {
		static createAsync(config: {
			model: { supertonic: Record<string, string>; numThreads?: number; provider?: string; debug?: number };
			maxNumSentences?: number;
		}): Promise<OfflineTts>;
		readonly sampleRate: number;
		readonly numSpeakers: number;
		generateAsync(request: {
			text: string;
			generationConfig: GenerationConfig;
			onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean | void;
		}): Promise<{ samples: Float32Array; sampleRate: number }>;
	}

	const sherpa: { OfflineTts: typeof OfflineTts; GenerationConfig: typeof GenerationConfig };
	export default sherpa;
}
