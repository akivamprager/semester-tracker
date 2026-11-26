// Runs on the tracker's pages only. Tells the app the extension is here, and passes its
// download requests to the background worker (the page itself can't reach Panopto: CORS).
document.documentElement.dataset.semestronDl = '1';
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.type !== 'semestron-dl') return;
  const { reqId, payload } = e.data;
  chrome.runtime.sendMessage({ type: 'download', ...payload }, (res) => {
    const out = res || { ok: false, error: chrome.runtime.lastError?.message || 'no-reply' };
    window.postMessage({ type: 'semestron-dl-result', reqId, res: out }, location.origin);
  });
});
