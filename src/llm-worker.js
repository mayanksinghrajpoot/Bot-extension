import { CreateMLCEngine } from "@mlc-ai/web-llm";

let engine = null;

self.onmessage = async (e) => {
    const { id, type, systemPrompt, userPrompt, model } = e.data;

    try {
        if (type === 'INIT') {
            const selectedModel = model || "Phi-3.5-mini-instruct-q4f16_1-MLC";
            engine = await CreateMLCEngine(selectedModel, {
                initProgressCallback: (progress) => {
                    self.postMessage({ id, type: 'PROGRESS', progress });
                },
                chatOpts: {
                    // Explicitly set a larger context window to prevent overflow
                    context_window_size: 8192,
                    // Sliding window as safety net for any edge-case overflow
                    sliding_window_size: 6144,
                }
            });
            self.postMessage({ id, type: 'READY' });
        }
        else if (type === 'GENERATE') {
            if (!engine) throw new Error("Engine not initialized");

            const messages = [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ];

            const chunks = await engine.chat.completions.create({
                messages,
                stream: true,
                temperature: 0.3,
                max_tokens: 1024  // Keeps output budget to 1024 tokens, leaving 3072 tokens for input on the 4096 window
            });

            for await (const chunk of chunks) {
                const text = chunk.choices[0]?.delta?.content || "";
                if (text) {
                    self.postMessage({ id, type: 'CHUNK', text });
                }
            }
            self.postMessage({ id, type: 'DONE' });
        }
    } catch (err) {
        self.postMessage({ id, type: 'ERROR', error: err.message });
    }
};
