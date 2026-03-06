(function () {
    const SEEN = new Set();
    const MIN_LENGTH = 30;
    const MAX_LENGTH = 15000;
    const DEBOUNCE_MS = 3000;
    const MSG_KEY = '__LOCAL_RAG_INTERCEPTED__';

    function hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0;
        }
        return hash;
    }

    function sendChunk(text, url, source) {
        if (!text || text.length < MIN_LENGTH || text.length > MAX_LENGTH) return;
        const h = hashCode(text);
        if (SEEN.has(h)) return;
        SEEN.add(h);
        window.postMessage({
            type: MSG_KEY,
            payload: text,
            url: url || '',
            source_type: source
        }, '*');
    }

    function extractTextFromHTML(html) {
        try {
            if (typeof html !== 'string') return '';

            // 1. Remove tags that contain non-readable or structural content
            let text = html.replace(/<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

            // 2. Remove all remaining open/close/self-closing HTML tags
            text = text.replace(/<[^>]+>/g, ' ');

            // 3. Decode common HTML entities
            text = text.replace(/&nbsp;/gi, ' ')
                .replace(/&amp;/gi, '&')
                .replace(/&lt;/gi, '<')
                .replace(/&gt;/gi, '>')
                .replace(/&quot;/gi, '"')
                .replace(/&#39;|&#x27;/gi, "'");

            // 4. Clean up structural whitespace
            return text.replace(/\s+/g, ' ').trim();
        } catch (e) {
            return '';
        }
    }

    function processResponseText(text, url, contentType) {
        if (!text) return;

        if (contentType && contentType.includes('application/json')) {
            try {
                const parsed = JSON.parse(text);
                if (Array.isArray(parsed)) {
                    parsed.forEach(item => {
                        const chunk = typeof item === 'string' ? item : JSON.stringify(item);
                        sendChunk(chunk, url, 'api-json');
                    });
                } else {
                    sendChunk(text, url, 'api-json');
                }
            } catch (e) {
                sendChunk(text, url, 'api-text');
            }
            return;
        }

        if (contentType && (contentType.includes('text/html') || contentType.includes('application/xhtml'))) {
            const extracted = extractTextFromHTML(text);
            if (extracted) {
                const chunks = splitTextIntoChunks(extracted, 2000);
                chunks.forEach(chunk => sendChunk(chunk, url, 'api-html'));
            }
            return;
        }

        if (contentType && (contentType.includes('text/xml') || contentType.includes('application/xml'))) {
            const extracted = extractTextFromHTML(text);
            if (extracted) {
                sendChunk(extracted, url, 'api-xml');
            }
            return;
        }

        if (!contentType || contentType.includes('text/')) {
            sendChunk(text, url, 'api-text');
        }
    }

    function splitTextIntoChunks(text, maxLen) {
        const chunks = [];
        const sentences = text.split(/(?<=[.!?])\s+/);
        let current = '';
        for (const s of sentences) {
            if ((current + ' ' + s).length > maxLen && current.length > 0) {
                chunks.push(current.trim());
                current = s;
            } else {
                current = current ? current + ' ' + s : s;
            }
        }
        if (current.trim()) chunks.push(current.trim());
        return chunks;
    }

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        let response;
        try {
            response = await originalFetch.apply(this, args);
        } catch (err) {
            throw err;
        }
        try {
            if (response.ok) {
                const contentType = response.headers.get('content-type') || '';
                const cloned = response.clone();
                cloned.text().then(text => {
                    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
                    processResponseText(text, url, contentType);
                }).catch(() => { });
            }
        } catch (e) { }
        return response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._interceptedUrl = url;
        return originalOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', function () {
            try {
                if (this.status >= 200 && this.status < 300) {
                    const contentType = this.getResponseHeader('content-type') || '';
                    processResponseText(this.responseText, this._interceptedUrl || '', contentType);
                }
            } catch (e) { }
        });
        return originalSend.apply(this, args);
    };

    let domTimer = null;
    let lastDomText = '';

    function scrapeDom() {
        try {
            const el = document.querySelector('main') || document.querySelector('article') || document.querySelector('#content') || document.querySelector('.content') || document.body;
            if (!el) return;

            const clone = el.cloneNode(true);
            clone.querySelectorAll('script, style, noscript, svg, iframe, nav, header, footer').forEach(n => n.remove());
            const text = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();

            if (text === lastDomText || text.length < MIN_LENGTH) return;
            lastDomText = text;

            const chunks = splitTextIntoChunks(text, 2000);
            chunks.forEach(chunk => sendChunk(chunk, window.location.href, 'dom'));
        } catch (e) { }
    }

    function debouncedDomScrape() {
        clearTimeout(domTimer);
        domTimer = setTimeout(scrapeDom, DEBOUNCE_MS);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(scrapeDom, 1000);
        });
    } else {
        setTimeout(scrapeDom, 1000);
    }

    const observer = new MutationObserver(debouncedDomScrape);
    const startObserver = () => {
        if (document.body) {
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true
            });
        }
    };

    if (document.body) {
        startObserver();
    } else {
        document.addEventListener('DOMContentLoaded', startObserver);
    }

    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            setTimeout(scrapeDom, 1500);
        }
    }, 1000);
})();
