import React, { useEffect, useState, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { initDB } from './db';
import { createLLM } from './llm';
import { buildEagerExtractionPrompt, buildSingleShotPrompt } from './rag-prompt';

function flattenToText(data) {
    if (typeof data === 'string') {
        try {
            const parsed = JSON.parse(data);
            return flattenToText(parsed);
        } catch {
            return data;
        }
    }
    if (Array.isArray(data)) {
        return data.map(flattenToText).join('\n');
    }
    if (typeof data === 'object' && data !== null) {
        return Object.entries(data)
            .filter(([, v]) => v !== null && v !== undefined)
            .map(([k, v]) => {
                const val = typeof v === 'object' ? flattenToText(v) : String(v);
                return `${k}: ${val}`;
            })
            .join('\n');
    }
    return String(data);
}

// Fallback chunking that respects sentence and paragraph boundaries instead of naive slicing
function splitBySentences(text, maxChars = 600) {
    if (text.length <= maxChars) return [text];

    // Split by newlines or sentence-ending punctuation followed by a space
    const segments = text.split(/(?<=[.?!])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 0);

    const chunks = [];
    let currentChunk = "";

    for (const segment of segments) {
        if (currentChunk.length + segment.length > maxChars && currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
            currentChunk = "";
        }
        currentChunk += (currentChunk ? " " : "") + segment;
    }

    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

function vectorToSql(vec) {
    return '[' + vec.join(',') + ']';
}

function SourceToggle({ sources }) {
    const [isOpen, setIsOpen] = useState(false);
    if (!sources || sources.length === 0) return null;

    return (
        <div className="mt-3 text-left">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-gray-400 hover:text-gray-200 bg-[#252533] hover:bg-[#2d2d3d] rounded-md transition-colors"
            >
                <span className={`transform transition-transform ${isOpen ? 'rotate-90' : ''}`}>▶</span>
                📎 Sources ({sources.length})
            </button>

            {isOpen && (
                <div className="mt-2 flex flex-col gap-2">
                    {sources.map((src, i) => (
                        <div key={i} className="bg-[#16161d] border border-gray-800 rounded p-2 text-[11px] text-gray-400 overflow-hidden">
                            <div className="font-semibold text-gray-500 mb-1 border-b border-gray-800 pb-1">Source {i + 1}</div>
                            <pre className="whitespace-pre-wrap font-mono m-0 overflow-x-auto max-h-32 text-left">{src}</pre>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default function ChatApp() {
    const [db, setDb] = useState(null);
    const [llm, setLlm] = useState(null);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [status, setStatus] = useState({ db: false, model: false, llm: 'Detecting...', docs: 0 });
    const [loading, setLoading] = useState(false);

    const workerRef = useRef(null);
    const callbacksRef = useRef({});
    const messageIdRef = useRef(0);
    const dbRef = useRef(null);
    const chatEndRef = useRef(null);
    const processingQueueRef = useRef([]);
    const isProcessingRef = useRef(false);

    // Background Eager Extraction States
    const llmRef = useRef(null);
    const loadingRef = useRef(false);
    const eagerQueueRef = useRef([]);
    const isEagerProcessingRef = useRef(false);

    // Sync loading state to ref for the background loop to check
    const setAppLoading = (val) => {
        setLoading(val);
        loadingRef.current = val;
    };

    // Initialize DB and LLM
    useEffect(() => {
        initDB().then(instance => {
            dbRef.current = instance;
            setDb(instance);
            setStatus(prev => ({ ...prev, db: true }));
        }).catch(err => {
            console.error("DB init failed:", err);
            setStatus(prev => ({ ...prev, db: false, llm: 'DB Error' }));
        });

        // Load LLM preference from extension storage
        const initLLM = async () => {
            try {
                const prefs = await chrome.storage.local.get(['llmProvider', 'webllmModel']);
                const engine = await createLLM(prefs.llmProvider || 'auto');

                setStatus(prev => ({ ...prev, llm: 'Loading Engine...' }));

                await engine.init(
                    "You are a local AI assistant. Answer questions concisely based on context.",
                    prefs.webllmModel || "Phi-3.5-mini-instruct-q4f16_1-MLC",
                    (progressText) => {
                        // Truncate long progress messages
                        let shortText = progressText;
                        if (shortText.length > 30) {
                            shortText = shortText.split(']').pop()?.trim() || shortText.substring(0, 30);
                        }
                        setStatus(prev => ({ ...prev, llm: shortText }));
                    }
                );

                setLlm(engine);
                llmRef.current = engine;
                setStatus(prev => ({ ...prev, llm: engine.getStatus() }));
            } catch (err) {
                console.error("LLM Init Error:", err);
                setStatus(prev => ({ ...prev, llm: 'LLM Error' }));
            }
        };
        initLLM();

        workerRef.current = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

        workerRef.current.onmessage = (event) => {
            const { id, vector, error } = event.data;
            if (id === 'model_ready') {
                setStatus(prev => ({ ...prev, model: true }));
                return;
            }
            if (callbacksRef.current[id]) {
                if (error) {
                    callbacksRef.current[id].reject(new Error(error));
                } else {
                    callbacksRef.current[id].resolve(vector);
                }
                delete callbacksRef.current[id];
            }
        };

        workerRef.current.postMessage({ id: 'warmup', text: 'test' });

        let chromeListener = null;
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
            chromeListener = (message) => {
                if (message.type === 'INTERCEPTED_API' && message.source === 'background') {
                    processingQueueRef.current.push({
                        payload: message.payload,
                        url: message.url
                    });
                    processQueue();
                }
            };
            chrome.runtime.onMessage.addListener(chromeListener);
        }

        return () => {
            workerRef.current?.terminate();
            if (chromeListener && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
                chrome.runtime.onMessage.removeListener(chromeListener);
            }
        };
    }, []);

    const getEmbedding = useCallback((text) => {
        return new Promise((resolve, reject) => {
            const id = messageIdRef.current++;
            callbacksRef.current[id] = { resolve, reject };
            workerRef.current.postMessage({ id, text });
        });
    }, []);

    const processEagerQueue = useCallback(async () => {
        if (isEagerProcessingRef.current || !dbRef.current || !llmRef.current) return;
        isEagerProcessingRef.current = true;

        while (eagerQueueRef.current.length > 0) {
            // Yield if user is actively generating an answer (or just generally let the event loop breathe)
            await new Promise(r => setTimeout(r, 100));
            if (loadingRef.current) {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            const batch = [];
            let currentChars = 0;
            // Pack up to 2000 chars of raw content into a background prompt (conservative limit for 4096 token window)
            while (eagerQueueRef.current.length > 0 && currentChars < 2000) {
                const text = eagerQueueRef.current.shift();
                batch.push(text);
                currentChars += text.length;
            }

            if (batch.length > 0) {
                try {
                    const prompt = buildEagerExtractionPrompt(batch);
                    let result = "";
                    const stream = llmRef.current.stream(prompt.user, prompt.system);
                    let aborted = false;

                    for await (const chunk of stream) {
                        if (loadingRef.current) {
                            aborted = true;
                            // Re-queue the unfinished batch so we don't lose the data
                            eagerQueueRef.current.unshift(...batch);
                            break; // User asked a question, abort background task!
                        }
                        result += chunk;
                        // Give breathing room to the main thread so UI doesn't freeze
                        await new Promise(r => setTimeout(r, 10));
                    }

                    if (aborted) continue;

                    const cleanedResult = result.trim().toLowerCase();
                    const isConversationalJunk =
                        cleanedResult.startsWith("i'm sorry") ||
                        cleanedResult.startsWith("i am sorry") ||
                        cleanedResult.startsWith("here is") ||
                        cleanedResult.startsWith("i cannot") ||
                        cleanedResult.startsWith("none");

                    if (result.trim() && !isConversationalJunk) {
                        // Validate it's not just a conversational hallucination before saving
                        if (result.length > 15) {
                            const vec = await getEmbedding(result);
                            const vecStr = vectorToSql(vec);
                            await dbRef.current.query(
                                'INSERT INTO pre_processed_entities (raw_extracted_text, embedding) VALUES ($1, $2::vector)',
                                [result.trim(), vecStr]
                            );
                        }
                    }
                } catch (e) { console.error("Eager extraction error:", e); }
            }
        }
        isEagerProcessingRef.current = false;
    }, [getEmbedding]);

    const processQueue = useCallback(async () => {
        if (isProcessingRef.current || !dbRef.current) return;
        isProcessingRef.current = true;

        while (processingQueueRef.current.length > 0) {
            const { payload } = processingQueueRef.current.shift();

            let chunks = [];
            try {
                const parsed = JSON.parse(payload);

                // 1. Semantic Strategy for Arrays of Objects (Common in APIs)
                // We keep each object together as a single logical entity (e.g. one Leetcode Problem).
                if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object') {
                    for (const item of parsed) {
                        const flattenedItem = flattenToText(item).trim();
                        if (flattenedItem.length > 10) {
                            // If an individual object is insanely huge, fallback to sentence splitting
                            if (flattenedItem.length > 1500) {
                                chunks.push(...splitBySentences(flattenedItem));
                            } else {
                                chunks.push(flattenedItem);
                            }
                        }
                    }
                }
                // 2. Semantic Strategy for generic Objects or huge raw Strings
                else {
                    const flattened = flattenToText(parsed).trim();
                    chunks.push(...splitBySentences(flattened));
                }
            } catch {
                // Not JSON, just split the string by sentences safely
                chunks.push(...splitBySentences(payload));
            }

            for (const chunk of chunks) {
                if (chunk.length < 10) continue;
                try {
                    const vec = await getEmbedding(chunk);
                    const vecStr = vectorToSql(vec);
                    await dbRef.current.query(
                        'INSERT INTO scraped_knowledge (content, embedding) VALUES ($1, $2::vector)',
                        [chunk, vecStr]
                    );
                    eagerQueueRef.current.push(chunk); // Queue micro-chunk for eager background extraction
                    setStatus(prev => ({ ...prev, docs: prev.docs + 1 }));
                } catch (e) { }
            }
        }

        isProcessingRef.current = false;
        processEagerQueue(); // Attempt to start eager extraction if idle
    }, [getEmbedding, processEagerQueue]);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const handleSend = async () => {
        if (!input.trim() || !db || !llm) return;

        const queryText = input;
        setInput('');

        // Add user message
        const newMessages = [...messages, { role: 'user', content: queryText }];
        setMessages(newMessages);
        setAppLoading(true);

        try {
            // 1. Hybrid Search (Vector + Keyword)
            const queryVector = await getEmbedding(queryText);
            const vecStr = vectorToSql(queryVector);

            const countResult = await db.query('SELECT COUNT(*) as cnt FROM scraped_knowledge');
            const totalDocs = parseInt(countResult.rows[0]?.cnt || '0', 10);

            if (totalDocs === 0) {
                setMessages([...newMessages, {
                    role: 'bot',
                    content: 'No documents stored yet. Browse a website first so I can learn from its content.'
                }]);
                setAppLoading(false);
                return;
            }

            // A: Vector Search (Top 25)
            const vectorResult = await db.query(
                'SELECT content, embedding <=> $1::vector AS distance FROM scraped_knowledge ORDER BY distance ASC LIMIT 25',
                [vecStr]
            );

            // B: Keyword Search (Fallback for exact matches which embeddings struggle with)
            // Extract meaningful words > 3 chars
            const keywords = queryText.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(' ').filter(w => w.length > 3);
            let keywordResult = { rows: [] };

            if (keywords.length > 0) {
                try {
                    // Create an ILIKE condition for each keyword
                    const conditions = keywords.map((_, i) => `content ILIKE $${i + 1}`).join(' OR ');
                    const params = keywords.map(k => `%${k}%`);
                    keywordResult = await db.query(
                        `SELECT content, 0 AS distance FROM scraped_knowledge WHERE ${conditions} LIMIT 15`,
                        params
                    );
                } catch (e) { console.error("Keyword search err:", e); }
            }

            // C: Eager Extracted Entities (Prioritized)
            let eagerResult = { rows: [] };
            try {
                eagerResult = await db.query(
                    'SELECT raw_extracted_text as content, embedding <=> $1::vector AS distance FROM pre_processed_entities ORDER BY distance ASC LIMIT 5',
                    [vecStr]
                );
            } catch (e) { }

            // Merge and Deduplicate Results
            const seen = new Set();
            const mergedRows = [];

            // Merging Priority 1: Eager Extracted Entities (Strict Match Only to avoid hallucinations)
            let usedEagerData = false;
            eagerResult.rows.forEach(row => {
                if (parseFloat(row.distance) < 0.45) { // Extremely strict threshold
                    const txt = flattenToText(row.content);
                    if (!seen.has(txt)) {
                        seen.add(txt);
                        mergedRows.push(row);
                        usedEagerData = true;
                    }
                }
            });

            // Merging Priority 2: Keyword Matches (Usually structural lists)
            keywordResult.rows.forEach(row => {
                const txt = flattenToText(row.content);
                if (!seen.has(txt)) { seen.add(txt); mergedRows.push(row); }
            });

            // Merging Priority 3: Raw Semantic Matches (Always unconditionally add Top-10 closest results)
            // This is the primary data source. Priority 1 & 2 are supplements.
            vectorResult.rows.slice(0, 10).forEach(row => {
                const txt = flattenToText(row.content);
                if (!seen.has(txt)) { seen.add(txt); mergedRows.push(row); }
            });

            if (mergedRows.length === 0) {
                setMessages([...newMessages, {
                    role: 'bot',
                    content: '⚠️ No matching information found. Try browsing to a page with relevant content first.'
                }]);
                setAppLoading(false);
                return;
            }

            // 2. O(1) Single-Shot Inference (Direct Synthesis from Micro-Chunks)
            // Since we use semantic micro-chunks, the top results easily fit within the 4096 context window.

            setAppLoading(false); // Done searching the DB — but keep loadingRef.current = true
            // Note: We keep loadingRef.current = true during synthesis to prevent eager extraction
            // from stealing the LLM thread while we are actively streaming the answer.
            loadingRef.current = true;

            const streamId = Date.now();
            // Pre-compute flattened text once per row to avoid triple re-computation
            const flatRows = mergedRows.map(r => flattenToText(r.content));
            setMessages(prev => [...prev, {
                id: streamId,
                role: 'bot',
                content: '🧠 Analyzing top connections...',
                sources: flatRows
            }]);

            // Combine the retrieved micro-chunks into a single block of raw data (pre-computed)
            const combinedExtraction = flatRows
                .map((txt, i) => `[Context ${i + 1}]:\n${txt}`)
                .join('\n\n');

            let finalSynthesis = "";
            const synthPrompt = buildSingleShotPrompt(queryText, combinedExtraction);
            const synthStream = llm.stream(synthPrompt.user, synthPrompt.system);

            let hasStartedStreaming = false;

            for await (const chunk of synthStream) {
                if (!hasStartedStreaming) {
                    hasStartedStreaming = true; // Clear the "Analyzing..." message
                }
                finalSynthesis += chunk;
                setMessages(prev =>
                    prev.map(msg =>
                        msg.id === streamId
                            ? { ...msg, content: finalSynthesis }
                            : msg
                    )
                );
            }

        } catch (e) {
            setMessages(prev => [...prev, { role: 'bot', content: '❌ Error: ' + e.message }]);
        } finally {
            setAppLoading(false);
        }
    };

    return (
        <div className="flex flex-col h-screen bg-[#0f0f14] text-gray-100 font-sans">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-[#16161d]">
                <h1 className="text-[15px] font-semibold tracking-wide text-white">Local AI Context</h1>
                <div className="flex items-center gap-3 text-[11px]">
                    <span className={`flex items-center gap-1 ${status.db ? 'text-emerald-400' : 'text-yellow-500'}`} title="Database Status">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${status.db ? 'bg-emerald-400' : 'bg-yellow-500 animate-pulse'}`}></span>
                        DB
                    </span>
                    <span className={`flex items-center gap-1 ${status.model ? 'text-emerald-400' : 'text-yellow-500'}`} title="Embeddings Model Status">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${status.model ? 'bg-emerald-400' : 'bg-yellow-500 animate-pulse'}`}></span>
                        EMB
                    </span>
                    <span className={`flex items-center gap-1 ${status.llm.includes('Error') ? 'text-red-400' : (status.llm === 'Chrome AI' || status.llm === 'WebLLM') ? 'text-emerald-400' : 'text-blue-400'}`} title="LLM Engine Status">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${status.llm.includes('Error') ? 'bg-red-400' : (status.llm === 'Chrome AI' || status.llm === 'WebLLM') ? 'bg-emerald-400' : 'bg-blue-400 animate-pulse'}`}></span>
                        <span className="max-w-[80px] truncate">{status.llm}</span>
                    </span>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-4 flex flex-col gap-4">
                {messages.length === 0 && (
                    <div className="flex-1 flex items-center justify-center">
                        <div className="text-center text-gray-500 text-sm max-w-[260px]">
                            <p className="text-2xl mb-3">🧠</p>
                            <p className="font-medium text-gray-400 mb-1">Waiting for context...</p>
                            <p className="text-[12px] leading-relaxed">Browse around! I am silently reading the page structure and network responses to answer your questions.</p>
                            <div className="mt-4 px-3 py-1.5 bg-[#1e1e2a] rounded-lg border border-gray-800 inline-block">
                                <span className="text-blue-400 font-mono text-[11px] font-bold">{status.docs} chunks</span> stored so far
                            </div>
                        </div>
                    </div>
                )}

                {messages.map((m, i) => (
                    <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                        <span className="uppercase text-[10px] font-bold tracking-wider text-gray-600 mb-1 px-1">
                            {m.role === 'user' ? 'You' : 'AI'}
                        </span>
                        <div className={`px-4 py-3 rounded-2xl max-w-[90%] text-[13px] leading-relaxed ${m.role === 'user'
                            ? 'bg-blue-600/90 text-white rounded-br-sm'
                            : 'bg-[#1e1e2a] text-gray-300 rounded-bl-sm border border-gray-800 w-full'
                            }`}>

                            {m.role === 'user' ? (
                                <p className="m-0 whitespace-pre-wrap">{m.content}</p>
                            ) : (
                                <div className="prose prose-invert prose-sm max-w-none 
                                    prose-p:leading-snug prose-p:my-1.5 
                                    prose-ul:my-1 prose-li:my-0.5 
                                    prose-code:text-blue-300 prose-code:bg-blue-900/30 prose-code:px-1 prose-code:py-0.5 prose-code:rounded 
                                    prose-strong:text-gray-100 text-left w-full block">
                                    <ReactMarkdown>{m.content}</ReactMarkdown>

                                    {m.content === '' && (
                                        <span className="inline-block w-1.5 h-3.5 bg-gray-400 ml-1 animate-pulse align-middle"></span>
                                    )}
                                </div>
                            )}

                            {m.role === 'bot' && m.sources && <SourceToggle sources={m.sources} />}
                        </div>
                    </div>
                ))}

                {loading && (
                    <div className="flex items-start flex-col">
                        <span className="uppercase text-[10px] font-bold tracking-wider text-gray-600 mb-1 px-1">AI</span>
                        <div className="px-4 py-3 rounded-2xl rounded-bl-sm bg-[#1e1e2a] border border-gray-800">
                            <div className="flex gap-1 py-1">
                                <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                                <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                                <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
                            </div>
                        </div>
                    </div>
                )}
                <div ref={chatEndRef} />
            </div>

            <div className="px-3 py-3 border-t border-gray-800 bg-[#16161d]">
                <div className="flex gap-2">
                    <input
                        type="text"
                        className="flex-1 px-3 py-2.5 text-[13px] bg-[#1e1e2a] border border-gray-700 rounded-xl text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-all"
                        placeholder={!llm ? "Initializing AI engine..." : "Ask about the current page content..."}
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
                        disabled={!db || loading || !llm}
                    />
                    <button
                        className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-[13px] font-medium rounded-xl transition-colors shrink-0"
                        onClick={handleSend}
                        disabled={!db || loading || !input.trim() || !llm}
                    >
                        Send
                    </button>
                </div>
            </div>
        </div>
    );
}
