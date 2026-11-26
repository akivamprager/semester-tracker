// Runs on the tracker's pages only. Tells the app the extension is here, and passes its
// download requests to the background worker (the page itself can't reach Panopto: CORS).
document.documentElement.dataset.semestronDl = '1';
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.type !== 'semestron-dl') return;
  const { reqId, payload } = e.data;
  const answer = (res) => window.postMessage({ type: 'semestron-dl-result', reqId, res }, location.origin);
  try {
    // After the extension is reloaded/updated, this copy of the script is cut off from it
    // until the page is reloaded: say so instead of leaving the page waiting.
    if (!chrome.runtime?.id) throw new Error('extension-reloaded');
    chrome.runtime.sendMessage({ type: 'download', ...payload }, (res) => {
      // if the extension was reloaded while we waited, even reading lastError throws
      let error = 'no-reply';
      try { error = chrome.runtime.lastError?.message || error; } catch { error = 'extension-reloaded'; }
      answer(res || { ok: false, error: /invalidated/i.test(error) ? 'extension-reloaded' : error });
    });
  } catch (err) {
    answer({ ok: false, error: /invalidated|extension-reloaded/i.test(String(err?.message)) ? 'extension-reloaded' : String(err?.message || err) });
  }
});
