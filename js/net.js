// Загрузка текста (m3u) с перебором CORS-прокси.
function timeoutSignal(ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(id) };
}

function applyProxy(template, url) {
  if (!template || template === 'direct') return url;
  return template.replace('{url}', encodeURIComponent(url));
}

let preferredProxy = null;

export async function fetchText(url, proxies = [], options = {}) {
  const ordered = preferredProxy
    ? [preferredProxy, ...proxies.filter((p) => p !== preferredProxy)]
    : proxies;
  const attempts = [];
  if (options.directFirst !== false) attempts.push({ label: 'direct', url });
  for (const p of ordered) attempts.push({ label: p, url: applyProxy(p, url) });
  if (options.directFirst === false) attempts.push({ label: 'direct', url });

  for (const attempt of attempts) {
    const { signal, done } = timeoutSignal(attempt.label === 'direct' ? 6000 : 12000);
    try {
      const res = await fetch(attempt.url, {
        signal,
        headers: { Accept: 'application/x-mpegURL, application/vnd.apple.mpegurl, text/plain, */*' },
      });
      done();
      if (!res.ok) continue;
      const text = await res.text();
      if (text && text.trim()) {
        if (attempt.label !== 'direct') preferredProxy = attempt.label;
        return text;
      }
    } catch {
      done();
    }
  }
  return null;
}
