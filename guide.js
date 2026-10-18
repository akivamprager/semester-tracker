// "Share this guide" button (kept out of guide.html so the page can forbid inline scripts).
document.getElementById('share-guide').addEventListener('click', async () => {
  const url = location.href.split('#')[0];
  const data = { title: 'הסמסטרון — מדריך', text: 'אפליקציה למעקב אחרי הרצאות, תרגולים והגשות בסמסטר:', url };
  try {
    if (navigator.share) { await navigator.share(data); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  await navigator.clipboard.writeText(url);
  alert('הקישור הועתק');
});
