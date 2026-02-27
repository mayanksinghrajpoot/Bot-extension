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
                    // Enable sliding window so very long prompts degrade gracefully
                    // instead of crashing with an overflow error
                    sliding_window_size: 3072,
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
                max_tokens: 2048  // Increased limit for list-heavy answers
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
