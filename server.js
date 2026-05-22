'use strict';

const express = require('express');
const crypto = require('crypto');

const WORKER_ORIGIN = process.env.WORKER_ORIGIN || 'https://commerce-shield-prod.ncassidy.workers.dev';
const PIXEL_GUARD_TTL_MS = parseInt(process.env.PIXEL_GUARD_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const PIXEL_GUARD_MAX_ENTRIES = 16;

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || 'dc386b789af148f54d80b54d07e63215';
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || '';
const SHOPIFY_SCOPES = 'read_discounts,write_discounts,read_orders,write_orders,read_products,write_products,read_script_tags,write_script_tags,read_themes,write_themes';
const SHOPIFY_APP_URL = (process.env.SHOPIFY_APP_URL || 'https://commerce-shield.onrender.com').replace(/\/$/, '');
const OAUTH_REDIRECT_URI = `${SHOPIFY_APP_URL}/auth/callback`;
const OAUTH_NONCE_TTL_MS = 10 * 60 * 1000;
const oauthNonces = new Map();

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level, message) {
  if (LEVELS[level] == null || LEVELS[level] < LEVELS[LOG_LEVEL]) return;
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, message }));
}

const app = express();

setInterval(() => {
  const now = Date.now();
  for (const [nonce, entry] of oauthNonces.entries()) {
    if (now - entry.ts > OAUTH_NONCE_TTL_MS) oauthNonces.delete(nonce);
  }
}, 60_000).unref();

function normalizeShopDomain(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(candidate) ? candidate : '';
}

function buildEmbeddedLaunchPath(shop, host) {
  const params = new URLSearchParams({ shop, embedded: '1' });
  if (host) params.set('host', host);
  return `/app?${params.toString()}`;
}

function buildShopifyAdminLaunchUrl(shop) {
  return `https://${shop}/admin/apps/${SHOPIFY_API_KEY}`;
}

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-XSS-Protection', '0');
  // Allow Shopify admin iframe embedding; allow calls to the Cloudflare Worker
  res.setHeader('Content-Security-Policy', "default-src 'self' https://commerce-shield-prod.ncassidy.workers.dev; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors https://*.myshopify.com https://admin.shopify.com");
  res.removeHeader('X-Powered-By');
  next();
});

// Parse JSON bodies (for signer and other API endpoints)
app.use(express.json({ limit: '10mb' }));

// Serve static admin UI (built by scripts/gen-ui.cjs from worker/src/index.js)
app.use(express.static('public'));

app.get('/auth', (req, res) => {
  const shop = normalizeShopDomain(req.query.shop);
  const host = String(req.query.host || '');
  if (!shop) return res.status(400).send('Missing or invalid shop parameter');

  if (!SHOPIFY_API_SECRET) {
    // Fail open to embedded app shell when secret is not configured.
    const launch = buildEmbeddedLaunchPath(shop, host);
    return res.redirect(302, launch);
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  oauthNonces.set(nonce, { shop, ts: Date.now() });

  const authUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authUrl.searchParams.set('client_id', SHOPIFY_API_KEY);
  authUrl.searchParams.set('scope', SHOPIFY_SCOPES);
  authUrl.searchParams.set('redirect_uri', OAUTH_REDIRECT_URI);
  authUrl.searchParams.set('state', nonce);
  if (host) authUrl.searchParams.set('host', host);
  return res.redirect(302, authUrl.toString());
});

app.get('/auth/callback', async (req, res) => {
  const shop = normalizeShopDomain(req.query.shop);
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  const hmac = String(req.query.hmac || '');
  const host = String(req.query.host || '');

  if (!shop || !code || !state || !hmac) {
    return res.status(400).send('Missing OAuth callback parameters');
  }

  const nonceEntry = oauthNonces.get(state);
  oauthNonces.delete(state);
  if (!nonceEntry || nonceEntry.shop !== shop) {
    return res.status(403).send('Invalid OAuth state');
  }

  const params = Object.keys(req.query)
    .filter((k) => k !== 'hmac' && req.query[k] != null)
    .sort()
    .map((k) => `${k}=${Array.isArray(req.query[k]) ? req.query[k][0] : req.query[k]}`)
    .join('&');

  const expected = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(params).digest('hex');
  const actual = hmac.toLowerCase();
  if (expected.length !== actual.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
    return res.status(403).send('HMAC validation failed');
  }

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      log('error', 'OAuth token exchange failed', { shop, status: tokenRes.status, body: body.slice(0, 300) });
      return res.status(500).send('Token exchange failed');
    }

    const tokenPayload = await tokenRes.json();
    if (tokenPayload && tokenPayload.access_token) {
      log('info', 'Shopify OAuth exchange completed', { shop, scope: tokenPayload.scope || '' });
    }
  } catch (error) {
    log('error', 'OAuth callback exception', { shop, message: error.message });
    return res.status(500).send('OAuth callback failed');
  }

  if (host) {
    return res.redirect(302, buildEmbeddedLaunchPath(shop, host));
  }
  return res.redirect(302, buildShopifyAdminLaunchUrl(shop));
});

app.get('/app', (req, res) => res.sendFile('index.html', { root: 'public' }));

// ---------------------------------------------------------------------------
// Pixel-guard caching proxy
// Storefront pageviews load /cs-pixel-guard.js. Cloudflare Workers on the
// workers.dev domain charge per request even with edge cache headers, which
// blew us past the 100k/day free quota. Render has no per-request quota, so
// we proxy the script through here with an in-memory TTL cache. The worker
// is hit at most once per ~24h per (shop, mode, enabled) variant; everything
// else is served from this process and downstream browser caches.
// ---------------------------------------------------------------------------
const pixelGuardCache = new Map(); // key -> { body, contentType, fetchedAt }

async function fetchPixelGuard(query) {
  const upstream = `${WORKER_ORIGIN}/cs-pixel-guard.js${query ? `?${query}` : ''}`;
  const r = await fetch(upstream, { headers: { 'User-Agent': 'commerce-shield-render-proxy/1.0' } });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`upstream ${r.status}: ${text.slice(0, 200)}`);
  }
  return {
    body: await r.text(),
    contentType: r.headers.get('content-type') || 'application/javascript; charset=utf-8',
    fetchedAt: Date.now(),
  };
}

app.get('/cs-pixel-guard.js', async (req, res) => {
  const query = req.originalUrl.includes('?') ? req.originalUrl.split('?')[1] : '';
  const key = query;
  const now = Date.now();
  const hit = pixelGuardCache.get(key);

  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=3600');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (hit && now - hit.fetchedAt < PIXEL_GUARD_TTL_MS) {
    res.setHeader('Content-Type', hit.contentType);
    res.setHeader('X-CS-Cache', 'HIT');
    return res.send(hit.body);
  }

  try {
    const fresh = await fetchPixelGuard(query);
    pixelGuardCache.set(key, fresh);
    if (pixelGuardCache.size > PIXEL_GUARD_MAX_ENTRIES) {
      const oldestKey = pixelGuardCache.keys().next().value;
      pixelGuardCache.delete(oldestKey);
    }
    res.setHeader('Content-Type', fresh.contentType);
    res.setHeader('X-CS-Cache', hit ? 'REFRESH' : 'MISS');
    return res.send(fresh.body);
  } catch (err) {
    log('error', `pixel-guard upstream failed: ${err.message}`);
    if (hit) {
      // Serve stale on upstream failure rather than break the storefront.
      res.setHeader('Content-Type', hit.contentType);
      res.setHeader('X-CS-Cache', 'STALE');
      return res.send(hit.body);
    }
    return res.status(502).type('application/javascript').send('/* commerce-shield: upstream unavailable */');
  }
});

function applyTurnstileCors(req, res) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

app.options('/api/turnstile-verify', (req, res) => {
  applyTurnstileCors(req, res);
  return res.status(204).end();
});

app.post('/api/turnstile-verify', async (req, res) => {
  applyTurnstileCors(req, res);

  const token = typeof req.body?.token === 'string' ? req.body.token.slice(0, 2048) : '';
  const action = typeof req.body?.action === 'string' ? req.body.action.slice(0, 50) : '';
  const shop = normalizeShopDomain(req.body?.shop);

  if (!token) {
    return res.status(400).json({ ok: false, error: 'missing_token' });
  }
  if (!shop) {
    return res.status(400).json({ ok: false, error: 'invalid_shop' });
  }

  try {
    const upstream = await fetch(`${WORKER_ORIGIN}/api/turnstile-verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'commerce-shield-render-proxy/1.0',
      },
      body: JSON.stringify({ token, action, shop }),
    });

    const bodyText = await upstream.text();
    let jsonBody;
    try {
      jsonBody = JSON.parse(bodyText);
    } catch {
      jsonBody = { ok: false, error: 'invalid_upstream_response' };
    }

    return res.status(upstream.status).json(jsonBody);
  } catch (err) {
    // Fail open on upstream transport errors to avoid login friction for humans.
    log('warn', `turnstile proxy upstream error: ${err.message}`);
    return res.status(200).json({ ok: true, note: 'upstream_error' });
  }
});

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

// GTM Signer: edge bot events
app.post('/api/integrations/edge-bot-event', async (req, res) => {
  try {
    const secret = process.env.EDGE_BOT_SHARED_SECRET;
    if (!secret) {
      return res.status(503).json({ error: 'Signer not configured: EDGE_BOT_SHARED_SECRET is missing' });
    }

    const bodyString = JSON.stringify(req.body);
    const timestamp = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    
    // Create HMAC signature: sha256(timestamp.nonce.body) with base64 secret
    const message = `${timestamp}.${nonce}.${bodyString}`;
    const signature = crypto
      .createHmac('sha256', Buffer.from(secret, 'base64'))
      .update(message)
      .digest('hex');

    // Forward to Worker with signed headers
    const workerUrl = `${WORKER_ORIGIN}/api/integrations/edge-bot-event`;
    const response = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CS-Timestamp': timestamp,
        'X-CS-Nonce': nonce,
        'X-CS-Signature': signature,
      },
      body: bodyString,
    });

    const responseBody = await response.text();
    let responseJson;
    try {
      responseJson = JSON.parse(responseBody);
    } catch (e) {
      responseJson = { body: responseBody };
    }

    res.status(response.status).json(responseJson);
  } catch (err) {
    log('error', `Signer error: ${err.message}`);
    res.status(500).json({ error: 'Signer service error', details: err.message });
  }
});

// Catch-all -> index.html
app.get('*', (_req, res) => res.sendFile('index.html', { root: 'public' }));

const PORT = parseInt(process.env.PORT || '10000', 10);
app.listen(PORT, () => log('info', `Commerce Shield UI listening on http://localhost:${PORT}`));