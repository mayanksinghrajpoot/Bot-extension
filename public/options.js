document.addEventListener('DOMContentLoaded', async () => {
    const providerRadios = document.querySelectorAll('input[name="provider"]');
    const webllmOptions = document.getElementById('webllm-options');
    const modelSelect = document.getElementById('model-select');
    const saveBtn = document.getElementById('save-btn');
    const saveStatus = document.getElementById('save-status');
    const clearBtn = document.getElementById('clear-btn');

    // Load existing settings
    const prefs = await chrome.storage.local.get(['llmProvider', 'webllmModel']);

    if (prefs.llmProvider) {
        document.querySelector(`input[value="${prefs.llmProvider}"]`).checked = true;
    }

    if (prefs.webllmModel) {
        modelSelect.value = prefs.webllmModel;
    }

    // Toggle WebLLM options disabled state
    function updateVisibility() {
        const isWebLLM = document.querySelector('input[value="webllm"]').checked ||
            document.querySelector('input[value="auto"]').checked;

        if (isWebLLM) {
            webllmOptions.classList.add('enabled');
        } else {
            webllmOptions.classList.remove('enabled');
        }

        // Update active card styling
        providerRadios.forEach(radio => {
            const label = radio.closest('label');
            if (radio.checked) {
                label.classList.add('active');
            } else {
                label.classList.remove('active');
            }
        });
    }

    providerRadios.forEach(radio => radio.addEventListener('change', updateVisibility));
    updateVisibility();

    // Save
    saveBtn.addEventListener('click', async () => {
        const provider = document.querySelector('input[name="provider"]:checked').value;
        const model = modelSelect.value;

        await chrome.storage.local.set({
            llmProvider: provider,
            webllmModel: model
        });

        saveStatus.style.opacity = '1';
        setTimeout(() => saveStatus.style.opacity = '0', 3000);
    });

    // Clear DB
    clearBtn.addEventListener('click', async () => {
        if (confirm('Are you sure you want to delete all scraped knowledge? This cannot be undone.')) {
            // Need to drop IndexedDB via indexedDB API since PGlite stores it there
            try {
                // Remove the db directory if run via Node, but here we run in browser so clear IndexedDB
                const dbs = await window.indexedDB.databases();
                for (const db of dbs) {
                    if (db.name.includes('pglite')) {
                        window.indexedDB.deleteDatabase(db.name);
                    }
                }
                alert('Database cleared! Restart the extension to take effect.');
            } catch (e) {
                alert('Failed to clear DB completely. Try reinstalling the extension.');
            }
        }
    });
});
