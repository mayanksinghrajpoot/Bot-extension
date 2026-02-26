self.addEventListener('fetch', event => {
    event.respondWith(
        (async () => {
            const response = await fetch(event.request);
            if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
                const clonedResponse = response.clone();
                const data = await clonedResponse.json();
                const textPayload = JSON.stringify(data);
                const clients = await self.clients.matchAll();
                clients.forEach(client => {
                    client.postMessage({ type: 'INTERCEPTED_API', payload: textPayload });
                });
            }
            return response;
        })()
    );
});
