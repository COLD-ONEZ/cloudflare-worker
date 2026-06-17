/**
 * Cloudflare Worker — GDrive Proxy + BZ (Buzzheavier/BZZHR/FuckingFast) Resolver
 * ================================================================================
 *
 * ROUTE 1 — GDrive Direct Download Proxy  (existing, unchanged)
 *   GET /?id=GDRIVE_FILE_ID&name=filename.mkv
 *   Streams the file directly with correct filename.
 *
 * ROUTE 2 — BZ Token Resolver + Redirect  (new)
 *   GET /bz?id=BZZHR_FILE_ID
 *   Fetches the bzzhr.co download page, extracts the signed ?v=TOKEN,
 *   then issues a 302 redirect to the direct download URL.
 *   Since this is Cloudflare → Cloudflare (bzzhr.co is also on CF),
 *   bot-protection is not triggered.
 *
 * SETUP:
 *   1. Create / update Worker at https://dash.cloudflare.com → Workers & Pages
 *   2. Paste this entire file as the Worker script
 *   3. Environment Variables (Settings → Variables):
 *        GDRIVE_API_KEY  =  your Google Drive API key  (existing)
 *   4. Deploy. Same WORKER_URL as before — no Vercel changes needed.
 *
 * HOW BACKEND USES ROUTE 2:
 *   When admin saves a BZ URL, backend stores:
 *     url: "https://your-worker.workers.dev/bz?id=FILE_ID"
 *   When user clicks Fast Download, they hit that Worker URL,
 *   Worker fetches fresh token and redirects → download starts.
 */

export default {
  async fetch(request, env) {

    // ── CORS preflight ──────────────────────────────────────────────────────
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
    const pathname = url.pathname;

    // ── ROUTE 2 — BZ Token Resolver (/bz) ──────────────────────────────────
    if (pathname === '/bz' || pathname === '/bz/') {
      return handleBZ(url);
    }

    // ── ROUTE 1 — GDrive Proxy (/) ──────────────────────────────────────────
    return handleGDrive(url, env);
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 1 — GDrive Direct Download Proxy (unchanged logic)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleGDrive(url, env) {
  const fileId   = url.searchParams.get('id');
  const filename = url.searchParams.get('name') || 'download';

  if (!fileId) {
    return new Response('Missing ?id= parameter', { status: 400 });
  }

  const apiKey = env.GDRIVE_API_KEY;
  if (!apiKey) {
    return new Response('Worker not configured: GDRIVE_API_KEY missing', { status: 500 });
  }

  // Fetch file from GDrive
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

  const headers = new Headers();
  for (const key of ['Content-Type', 'Content-Length', 'Last-Modified', 'ETag']) {
    const val = upstream.headers.get(key);
    if (val) headers.set(key, val);
  }

  const safeName = filename.replace(/["\r\n]/g, '_');
  headers.set('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Allow-Origin', '*');

  return new Response(upstream.body, { status: upstream.status, headers });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 2 — BZ Token Resolver
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetches the bzzhr.co/buzzheavier.com download page for a given file ID,
 * extracts the signed download token (?v=...) from the page HTML,
 * and redirects the user to the direct download URL.
 *
 * Token extraction: the page contains a link like:
 *   href="https://ts.bzzhr.co/d/FILE_ID?v=TOKEN"
 * We extract that and redirect.
 */
async function handleBZ(url) {
  const fileId = url.searchParams.get('id');
  if (!fileId) {
    return new Response('Missing ?id= parameter', { status: 400 });
  }

  // Try bzzhr.co first, fallback to buzzheavier.com
  const pagesToTry = [
    `https://bzzhr.co/${fileId}`,
    `https://buzzheavier.com/${fileId}`,
  ];

  let html = null;
  let lastStatus = 0;

  for (const pageUrl of pagesToTry) {
    try {
      const resp = await fetch(pageUrl, {
        method: 'GET',
        headers: {
          // Mimic a real browser — important for Cloudflare to pass the request
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control':   'no-cache',
        },
        redirect: 'follow',
      });
      lastStatus = resp.status;
      if (resp.ok) {
        html = await resp.text();
        break;
      }
    } catch (_) {}
  }

  if (!html) {
    return new Response(`Failed to fetch BZ page (status ${lastStatus})`, { status: 502 });
  }

  // ── Extract signed download URL from page HTML ────────────────────────────
  // The page HTML contains something like:
  //   href="https://ts.bzzhr.co/d/FILE_ID?v=LONG_TOKEN"
  // or
  //   href="https://ts.buzzheavier.com/d/FILE_ID?v=LONG_TOKEN"
  const directUrl = extractBZDownloadUrl(html, fileId);

  if (!directUrl) {
    // File may have been deleted — return 404
    return new Response('Could not extract download URL — file may be deleted', { status: 404 });
  }

  // Redirect user directly to the signed download URL
  return Response.redirect(directUrl, 302);
}

/**
 * Extracts the direct signed download URL from the BZ page HTML.
 * Tries multiple patterns to be resilient against minor page changes.
 */
function extractBZDownloadUrl(html, fileId) {
  // Pattern 1: href containing ?v= token on ts.bzzhr.co or ts.buzzheavier.com
  // e.g. https://ts.bzzhr.co/d/tmddoautdpfa?v=TOKEN
  const patterns = [
    // Full URL with token in href attribute
    /href="(https:\/\/ts\.bzzhr\.co\/d\/[^"?]+\?v=[^"]+)"/i,
    /href="(https:\/\/ts\.buzzheavier\.com\/d\/[^"?]+\?v=[^"]+)"/i,
    // Any ts. subdomain
    /href="(https:\/\/ts\.[^"\/]+\/d\/[^"?]+\?v=[^"]+)"/i,
    // Looser: any URL with /d/ and ?v= token
    /(https:\/\/[^"'\s]+\/d\/[^"'\s?]+\?v=[^"'\s]+)/i,
  ];

  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m && m[1]) {
      return m[1];
    }
  }

  // Pattern 2: look for the "Copy download link" anchor text nearby
  // Some page versions embed it as data attribute or JS variable
  const jsPatterns = [
    /downloadUrl\s*[:=]\s*["'](https:\/\/[^"']+\?v=[^"']+)["']/i,
    /copy_link\s*[:=]\s*["'](https:\/\/[^"']+\?v=[^"']+)["']/i,
    /"url"\s*:\s*"(https:\/\/[^"]+\?v=[^"]+)"/i,
  ];

  for (const pattern of jsPatterns) {
    const m = html.match(pattern);
    if (m && m[1]) {
      return m[1];
    }
  }

  return null;
}
