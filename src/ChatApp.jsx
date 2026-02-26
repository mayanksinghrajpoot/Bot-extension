import React, { useEffect, useState, useRef, useCallback } from 'react';
import { initDB } from './db';

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

function vectorToSql(vec) {
    return '[' + vec.join(',') + ']';
}

export default function ChatApp() {
    const [db, setDb] = useState(null);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [status, setStatus] = useState({ db: false, model: false, docs: 0 });
    const [loading, setLoading] = useState(false);

    const workerRef = useRef(null);
    const callbacksRef = useRef({});
    const messageIdRef = useRef(0);
    const dbRef = useRef(null);
    const chatEndRef = useRef(null);
    const processingQueueRef = useRef([]);
    const isProcessingRef = useRef(false);

    const getEmbedding = useCallback((text) => {
        return new Promise((resolve, reject) => {
            const id = messageIdRef.current++;
            callbacksRef.current[id] = { resolve, reject };
            workerRef.current.postMessage({ id, text });
        });
    }, []);

    const processQueue = useCallback(async () => {
        if (isProcessingRef.current || !dbRef.current) return;
        isProcessingRef.current = true;

        while (processingQueueRef.current.length > 0) {
            const { payload } = processingQueueRef.current.shift();

            let items = [];
            try {
                const parsed = JSON.parse(payload);
                if (Array.isArray(parsed)) {
                    items = parsed.map(item => ({
                        raw: typeof item === 'string' ? item : JSON.stringify(item),
                        readable: flattenToText(item)
                    }));
                } else {
                    items = [{
                        raw: payload,
                        readable: flattenToText(parsed)
                    }];
                }
            } catch {
                items = [{ raw: payload, readable: payload }];
            }

            for (const { raw, readable } of items) {
                if (readable.length < 10 || readable.length > 10000) continue;
                try {
                    const vec = await getEmbedding(readable);
                    const vecStr = vectorToSql(vec);
                    await dbRef.current.query(
                        'INSERT INTO scraped_knowledge (content, embedding) VALUES ($1, $2::vector)',
                        [raw, vecStr]
                    );
                    setStatus(prev => ({ ...prev, docs: prev.docs + 1 }));
                } catch (e) { }
            }
        }

        isProcessingRef.current = false;
    }, [getEmbedding]);

    useEffect(() => {
        initDB().then(instance => {
            dbRef.current = instance;
            setDb(instance);
            setStatus(prev => ({ ...prev, db: true }));
        });

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
    }, [processQueue]);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const handleSend = async () => {
        if (!input.trim() || !db) return;

        const queryText = input;
        setInput('');
        setMessages(prev => [...prev, { role: 'user', content: queryText }]);
        setLoading(true);

        try {
            const queryVector = await getEmbedding(queryText);
            const vecStr = vectorToSql(queryVector);

            const countResult = await db.query('SELECT COUNT(*) as cnt FROM scraped_knowledge');
            const totalDocs = parseInt(countResult.rows[0]?.cnt || '0', 10);

            if (totalDocs === 0) {
                setMessages(prev => [...prev, {
                    role: 'bot',
                    content: 'No documents stored yet. Browse a website first so I can learn from its content.'
                }]);
                setLoading(false);
                return;
            }

            const result = await db.query(
                'SELECT content, embedding <=> $1::vector AS distance FROM scraped_knowledge ORDER BY distance ASC LIMIT 5',
                [vecStr]
            );

            if (result.rows.length === 0) {
                setMessages(prev => [...prev, {
                    role: 'bot',
                    content: 'No matching results found.'
                }]);
            } else {
                const formattedResults = result.rows.map((row, i) => {
                    const readableContent = flattenToText(row.content);
                    const dist = parseFloat(row.distance).toFixed(4);
                    return `📄 Result ${i + 1} (relevance: ${(1 - parseFloat(dist)).toFixed(2)})\n${readableContent}`;
                }).join('\n\n───────────────\n\n');

                setMessages(prev => [...prev, {
                    role: 'bot',
                    content: formattedResults
                }]);
            }
        } catch (e) {
            setMessages(prev => [...prev, { role: 'bot', content: 'Error: ' + e.message }]);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex flex-col h-screen bg-[#0f0f14] text-gray-100 font-sans">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-[#16161d]">
                <h1 className="text-[15px] font-semibold tracking-wide text-white">Local RAG Chat</h1>
                <div className="flex items-center gap-3 text-[11px]">
                    <span className={`flex items-center gap-1 ${status.db ? 'text-emerald-400' : 'text-yellow-500'}`}>
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${status.db ? 'bg-emerald-400' : 'bg-yellow-500 animate-pulse'}`}></span>
                        DB
                    </span>
                    <span className={`flex items-center gap-1 ${status.model ? 'text-emerald-400' : 'text-yellow-500'}`}>
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${status.model ? 'bg-emerald-400' : 'bg-yellow-500 animate-pulse'}`}></span>
                        Model
                    </span>
                    <span className="text-blue-400 font-mono">{status.docs} docs</span>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-4 flex flex-col gap-3">
                {messages.length === 0 && (
                    <div className="flex-1 flex items-center justify-center">
                        <div className="text-center text-gray-500 text-sm max-w-[260px]">
                            <p className="text-2xl mb-3">🔍</p>
                            <p className="font-medium text-gray-400 mb-1">No data yet</p>
                            <p className="text-[12px] leading-relaxed">Browse a website to start intercepting API responses. They'll be vectorized and stored locally.</p>
                        </div>
                    </div>
                )}
                {messages.map((m, i) => (
                    <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                        <span className="uppercase text-[10px] font-bold tracking-wider text-gray-600 mb-1 px-1">
                            {m.role === 'user' ? 'You' : 'Context'}
                        </span>
                        <div className={`px-3 py-2.5 rounded-2xl max-w-[90%] text-[13px] leading-relaxed ${m.role === 'user'
                            ? 'bg-blue-600 text-white rounded-br-sm'
                            : 'bg-[#1e1e2a] text-gray-300 rounded-bl-sm border border-gray-800'
                            }`}>
                            <pre className="whitespace-pre-wrap font-sans m-0">{m.content}</pre>
                        </div>
                    </div>
                ))}
                {loading && (
                    <div className="flex items-start">
                        <div className="px-3 py-2.5 rounded-2xl rounded-bl-sm bg-[#1e1e2a] border border-gray-800">
                            <div className="flex gap-1">
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
                        placeholder="Ask about intercepted data..."
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
                        disabled={!db || loading}
                    />
                    <button
                        className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-[13px] font-medium rounded-xl transition-colors"
                        onClick={handleSend}
                        disabled={!db || loading || !input.trim()}
                    >
                        Send
                    </button>
                </div>
            </div>
        </div>
    );
}
