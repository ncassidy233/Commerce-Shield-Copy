/**
 * GCW Bot Protection GTM Test
 * Run locally: node gcw-bot-protection-test.js
 * Requires: npm install puppeteer
 */

const puppeteer = require('puppeteer');

const TARGET_URL = 'https://www.gerberchildrenswear.com/';
const GTM_ID     = 'GTM-TKW58K8';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function humanMouseWiggle(page) {
  const moves = [[320,400],[500,300],[700,500],[400,600],[600,200],[800,450],[350,350]];
  for (const [x, y] of moves) {
    await page.mouse.move(x, y, { steps: 15 });
    await sleep(120 + Math.random() * 180);
  }
}

async function humanScroll(page) {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(d => window.scrollBy(0, d), 200 + Math.random() * 200);
    await sleep(400 + Math.random() * 400);
  }
}

async function grabGTMState(page, gtmId) {
  return page.evaluate((id) => {
    const dl = window.dataLayer || [];
    return {
      dataLayerLength:    dl.length,
      gtmScriptTag:       [...document.querySelectorAll('script[src]')].some(s => s.src.includes('googletagmanager.com/gtm.js')),
      gtmInlineInit:      [...document.querySelectorAll('script')].some(s => s.textContent.includes(id)),
      gtmContainerLoaded: dl.some(e => e.event === 'gtm.js' || e['gtm.start']),
      recentEvents:       dl.slice(0, 10).map(e => ({ event: e.event, keys: Object.keys(e).join(', ') }))
    };
  }, gtmId);
}

async function runSession(label, launchOptions, pageSetup) {
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  ${label}`);
  console.log(`${'═'.repeat(62)}`);

  const browser = await puppeteer.launch(launchOptions);
  const page    = await browser.newPage();

  // Capture pixel/analytics network hits
  const networkHits = [];
  page.on('request', req => {
    const url = req.url();
    const isTracking =
      url.includes('googletagmanager.com') ||
      url.includes('google-analytics.com') ||
      url.includes('/collect') ||
      url.includes('doubleclick') ||
      url.includes('facebook.net') ||
      url.includes('reddit.com/ads') ||
      url.includes('rdt.li') ||
      url.includes('tiktok') ||
      url.includes('snap.licdn') ||
      url.includes('triplewhale') ||
      url.includes('bloomreach');
    if (isTracking) networkHits.push({ method: req.method(), url: url.substring(0, 120) });
  });

  if (pageSetup) await pageSetup(page);

  console.log(`  → Navigating...`);
  const res = await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  console.log(`  → HTTP ${res.status()}  |  ${page.url()}`);

  if (label.includes('HUMAN')) {
    console.log(`  → Simulating human behaviour...`);
    await humanMouseWiggle(page);
    await humanScroll(page);
    await sleep(2500);
  } else {
    await sleep(1500);
  }

  const gtm = await grabGTMState(page, GTM_ID);

  console.log(`\n  ── GTM State ─────────────────────────────────────────`);
  console.log(`  Script tag present : ${gtm.gtmScriptTag       ? '✅ YES' : '❌ NO'}`);
  console.log(`  Inline init present: ${gtm.gtmInlineInit       ? '✅ YES' : '❌ NO'}`);
  console.log(`  Container loaded   : ${gtm.gtmContainerLoaded  ? '✅ YES' : '❌ NO'}`);
  console.log(`  dataLayer length   : ${gtm.dataLayerLength}`);

  console.log(`\n  ── dataLayer events ──────────────────────────────────`);
  if (!gtm.recentEvents.length) {
    console.log('  (dataLayer empty)');
  } else {
    gtm.recentEvents.forEach((e, i) =>
      console.log(`  [${i}] event="${e.event || '(none)'}"  keys: ${e.keys}`)
    );
  }

  console.log(`\n  ── Pixel / Analytics network hits ────────────────────`);
  if (!networkHits.length) {
    console.log('  (none — pixels suppressed or GTM blocked)');
  } else {
    networkHits.forEach(h => console.log(`  ${h.method.padEnd(6)} ${h.url}`));
  }

  await browser.close();
  return { gtm, networkHits };
}

(async () => {
  console.log(`\nGCW Bot Protection GTM Test`);
  console.log(`Target : ${TARGET_URL}`);
  console.log(`GTM ID : ${GTM_ID}`);
  console.log(`Time   : ${new Date().toISOString()}`);

  // ── SESSION 1: Human ───────────────────────────────────────────────────────
  const humanResult = await runSession(
    '👤  HUMAN — real UA, spoofed webdriver, mouse + scroll',
    {
      headless: false, // set true if you don't want a window to pop up
      args: [
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      ]
    },
    async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      });
      await page.setViewport({ width: 1440, height: 900 });
    }
  );

  await sleep(2000);

  // ── SESSION 2: Bot ─────────────────────────────────────────────────────────
  const botResult = await runSession(
    '🤖  BOT — Googlebot UA, webdriver=true, no interaction',
    {
      headless: true,
      args: [
        '--user-agent=Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        '--blink-settings=imagesEnabled=false'
      ]
    },
    async (page) => {
      // Leave navigator.webdriver = true (headless default = bot signal)
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'plugins',   { get: () => [] });
        Object.defineProperty(navigator, 'languages', { get: () => [] });
      });
      await page.setViewport({ width: 1280, height: 800 });
    }
  );

  // ── SUMMARY ────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  SUMMARY`);
  console.log(`${'═'.repeat(62)}`);

  const humanGTM = humanResult.gtm.gtmContainerLoaded;
  const botGTM   = botResult.gtm.gtmContainerLoaded;
  const humanPx  = humanResult.networkHits.length;
  const botPx    = botResult.networkHits.length;

  console.log(`\n  GTM container loaded:`);
  console.log(`    Human : ${humanGTM ? '✅ YES' : '❌ NO'}`);
  console.log(`    Bot   : ${botGTM   ? '⚠️  YES (leaking through!)' : '✅ NO (suppressed)'}`);

  console.log(`\n  Pixel / analytics network requests:`);
  console.log(`    Human : ${humanPx} hit(s)`);
  console.log(`    Bot   : ${botPx} hit(s) ${botPx === 0 ? '✅ clean' : '⚠️  leaking'}`);

  const passed = humanGTM && !botGTM && botPx === 0;
  console.log(`\n  Result: ${passed
    ? '✅ PASS — bot suppression working correctly'
    : '⚠️  REVIEW — see details above'
  }`);
  console.log();
})();
