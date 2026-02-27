import { pipeline, env } from '@xenova/transformers';

// Chrome MV3 extensions cannot use blob: URLs for sub-workers.
// Disable proxy (which creates a blob worker) and force single-threaded WASM.
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.numThreads = 1;

let pipelineInstance = null;

async function getPipeline() {
    if (!pipelineInstance) {
        let device = 'wasm';
        try {
            if (typeof navigator !== 'undefined' && navigator.gpu) {
                const adapter = await navigator.gpu.requestAdapter();
                if (adapter) device = 'webgpu';
            }
        } catch (e) { }

        pipelineInstance = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
            device: device
        });
        self.postMessage({ id: 'model_ready' });
    }
    return pipelineInstance;
}

self.onmessage = async (event) => {
    const { id, text } = event.data;
    try {
        const generateEmbedding = await getPipeline();
        const output = await generateEmbedding(text, { pooling: 'mean', normalize: true });
        self.postMessage({ id, vector: Array.from(output.data) });
    } catch (e) {
        self.postMessage({ id, error: e.message });
    }
};
