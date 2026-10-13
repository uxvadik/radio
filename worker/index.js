// Простой CORS-прокси для Cloudflare Workers (бесплатный тариф).
// Использование:  https://<worker>.<subdomain>.workers.dev/?url=<encodeURIComponent(цель)>
// Например, для статуса Icecast: ?url=https%3A%2F%2Fice.example.com%2Fstatus-json.xsl

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('usage: ?url=<encoded>', { status: 400, headers: CORS });

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return new Response('invalid url', { status: 400, headers: CORS });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return new Response('invalid protocol', { status: 400, headers: CORS });
    }

    try {
      const upstream = await fetch(parsed.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (RadioPWA proxy)',
          Accept: 'application/json, text/plain, */*',
        },
        redirect: 'follow',
      });
      const headers = new Headers(CORS);
      headers.set('Content-Type', upstream.headers.get('Content-Type') || 'text/plain; charset=utf-8');
      headers.set('Cache-Control', 'no-store');
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (e) {
      return new Response('upstream error: ' + e.message, { status: 502, headers: CORS });
    }
  },
};
