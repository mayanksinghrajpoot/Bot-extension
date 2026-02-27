/**
 * Manages the LLM Adapter layer. 
 * Detects whether to use Chrome Built-in AI (first choice) or WebLLM (fallback).
 */

class ChromeAIProvider {
    constructor() {
        this.session = null;
    }

    async init(systemPrompt) {
        if (typeof ai === 'undefined' || !ai.languageModel) {
            throw new Error("Chrome Built-in AI not available.");
        }

        // Check availability
        const capabilities = await ai.languageModel.capabilities();
        if (capabilities.available === 'no') {
            throw new Error("Chrome Built-in AI is disabled or unavailable.");
        }

        // Create session
        this.session = await ai.languageModel.create({
            systemPrompt: systemPrompt
        });
    }

    async *stream(userPrompt, systemPromptOverride = null) {
        if (!this.session) throw new Error("Session not initialized");

        // Chrome AI sessions are fixed to their initial system prompt, so we inject the override.
        const finalPrompt = systemPromptOverride
            ? `[System Instructions Override]:\n${systemPromptOverride}\n\n[User Query]:\n${userPrompt}`
            : userPrompt;

        const stream = this.session.promptStreaming(finalPrompt);
        let previousLength = 0;

        for await (const chunk of stream) {
            const newText = chunk.slice(previousLength);
            previousLength = chunk.length;
            yield newText;
        }
    }

    destroy() {
        if (this.session) {
            this.session.destroy();
            this.session = null;
        }
    }

    getStatus() {
        return "Chrome AI";
    }
}

class WebLLMProvider {
    constructor() {
        this.worker = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
        this.messageId = 0;
        this.resolves = {};
        this.streams = {};

        this.worker.onmessage = (e) => {
            const { id, type, text, error, progress } = e.data;
            if (type === 'PROGRESS' && this.onProgress) {
                this.onProgress(progress.text);
            } else if (type === 'READY') {
                if (this.resolves[id]) this.resolves[id]();
            } else if (type === 'CHUNK') {
                if (this.streams[id]) this.streams[id](text);
            } else if (type === 'DONE') {
                if (this.streams[id + '_done']) this.streams[id + '_done']();
            } else if (type === 'ERROR') {
                console.error("WebLLM Error:", error);
                if (this.resolves[id]) this.resolves[id](new Error(error));
            }
        };
    }

    async init(systemPrompt, model = "Phi-3.5-mini-instruct-q4f16_1-MLC", onProgress) {
        this.systemPrompt = systemPrompt;
        this.onProgress = onProgress;

        try {
            return await new Promise((resolve, reject) => {
                const id = ++this.messageId;
                this.resolves[id] = (err) => err ? reject(err) : resolve();
                this.worker.postMessage({ id, type: 'INIT', model });
            });
        } catch (e) {
            console.error("WebLLM Provider Init Catch:", e);
            throw e;
        }
    }

    async *stream(userPrompt, systemPromptOverride = null) {
        const id = ++this.messageId;

        // Set up streaming queues
        const queue = [];
        let isDone = false;
        let resolveQueue = null;

        this.streams[id] = (text) => {
            queue.push(text);
            if (resolveQueue) {
                resolveQueue();
                resolveQueue = null;
            }
        };

        this.streams[id + '_done'] = () => {
            isDone = true;
            if (resolveQueue) resolveQueue();
        };

        this.worker.postMessage({
            id,
            type: 'GENERATE',
            systemPrompt: systemPromptOverride || this.systemPrompt,
            userPrompt
        });

        // Async generator to yield chunks
        while (!isDone || queue.length > 0) {
            if (queue.length > 0) {
                yield queue.shift();
            } else {
                await new Promise(r => resolveQueue = r);
            }
        }
    }

    destroy() {
        this.worker.terminate();
    }

    getStatus() {
        return "WebLLM";
    }
}

export async function createLLM(preferredProvider = 'auto', modelConfig = {}) {
    if (preferredProvider === 'auto' || preferredProvider === 'chrome') {
        try {
            if (typeof ai !== 'undefined' && ai.languageModel) {
                const capabilities = await ai.languageModel.capabilities();
                if (capabilities.available !== 'no') {
                    return new ChromeAIProvider();
                }
            }
        } catch (e) {
            console.warn("Chrome AI check failed, falling back to WebLLM", e.message || String(e));
        }
    }

    if (preferredProvider === 'chrome') {
        throw new Error("Chrome AI was requested but is not available.");
    }

    return new WebLLMProvider();
}
