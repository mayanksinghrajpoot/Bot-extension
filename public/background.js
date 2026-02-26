chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'INTERCEPTED_API') {
        chrome.runtime.sendMessage({
            type: 'INTERCEPTED_API',
            payload: message.payload,
            url: message.url,
            source: 'background'
        }).catch(() => { });
    }
    return false;
});
