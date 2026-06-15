export default {
  async fetch(request, env) {
    // ── CORS preflight ────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const url      = new URL(request.url);
    const fileId   = url.searchParams.get('id');
    const filename = url.searchParams.get('name') || 'download';

    if (!fileId) {
      return new Response('Missing ?id= parameter', { status: 400 });
    }

    const apiKey = env.GDRIVE_API_KEY;
    if (!apiKey) {
      return new Response('Worker not configured: GDRIVE_API_KEY missing', { status: 500 });
    }

    // ── Fetch file from GDrive ────────────────────────────────────────────
    const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${apiKey}`;

    let upstream;
    try {
      upstream = await fetch(driveUrl, { redirect: 'follow' });
    } catch (err) {
      return new Response(`Upstream fetch failed: ${err.message}`, { status: 502 });
    }

    if (!upstream.ok) {
      return new Response(`GDrive returned ${upstream.status}`, { status: upstream.status });
    }

    // ── Build response headers ────────────────────────────────────────────
    const headers = new Headers();

    // Passthrough useful headers from GDrive
    for (const key of ['Content-Type', 'Content-Length', 'Last-Modified', 'ETag']) {
      const val = upstream.headers.get(key);
      if (val) headers.set(key, val);
    }

    // Set correct filename — this is the whole point of the proxy
    const safeName = filename.replace(/["\r\n]/g, '_');
    headers.set('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);

    // Allow browser to show download progress
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Access-Control-Allow-Origin', '*');

    // ── Stream file to client ─────────────────────────────────────────────
    return new Response(upstream.body, {
      status:  upstream.status,
      headers,
    });
  },
};
