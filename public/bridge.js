window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === '__LOCAL_RAG_INTERCEPTED__') {
        try {
            chrome.runtime.sendMessage({
                type: 'INTERCEPTED_API',
                payload: event.data.payload,
                url: event.data.url || '',
                source_type: event.data.source_type || 'unknown'
            });
        } catch (e) { }
    }
});
