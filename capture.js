'use strict';
/**
 * Browser side of a capture job: sign in, visit each target, clean the page,
 * mask personal details, read what is on screen, take the screenshot.
 *
 * Read-only by construction:
 *   - The only typing is the username and password at sign-in.
 *   - Menu steps and URLs whose words could change data are refused, before
 *     anything is clicked or opened (DANGER below).
 *   - After sign-in, the browser itself refuses DELETE, PUT and PATCH
 *     requests and form posts that would load a new page.
 *   - New windows a click opens are closed, not followed.
 */

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const png = require('./png-meta');

const DANGER = /\b(delete|remove|deactivate|disable|archive|purge|reset|revoke|terminate|sign\s?out|sign\s?off|log\s?out|log\s?off|logout|logoff|signout|save|submit|approve|reject|decline|send|publish|unpublish|pay|purchase|buy|checkout|import|upload|assign|unassign|enrol+|register|request|launch|confirm)\b/i;
const PASS_SEL = 'input[type="password"]';
const USER_SEL = [
  'input[type="email"]', 'input[autocomplete="username"]',
  'input[name*="user" i]', 'input[id*="user" i]', 'input[name*="login" i]', 'input[id*="login" i]',
  'input[name*="email" i]', 'input[id*="email" i]', 'input[type="text"]', 'input:not([type])',
].join(', ');
const MAX_TARGETS = 50;

class CaptureError extends Error {
  constructor(message) { super(message); this.userMessage = message; }
}

// ── Inputs ─────────────────────────────────────────────────────────────────

function parseSize(s) {
  const m = String(s || '1512x709').toLowerCase().replace(/\s/g, '').replace('×', 'x').match(/^(\d{3,4})x(\d{3,4})$/);
  if (!m) throw new CaptureError('Image size must look like 1512x709');
  const width = Number(m[1]), height = Number(m[2]);
  if (width < 800 || width > 3840 || height < 400 || height > 2160) {
    throw new CaptureError('Image size must be between 800x400 and 3840x2160');
  }
  return { width, height };
}

/**
 * One target per line: a web address, a path starting with "/", or a menu
 * path such as "Admin > Users". Blank lines and lines starting with # are ignored.
 */
function parseTargets(text, environmentUrl) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  if (!lines.length) throw new CaptureError('List at least one page to capture');
  if (lines.length > MAX_TARGETS) throw new CaptureError('List at most ' + MAX_TARGETS + ' pages in one run');
  return lines.map((raw) => {
    if (/^https?:\/\//i.test(raw)) return { raw, url: raw };
    if (raw.startsWith('/')) return { raw, url: new URL(raw, environmentUrl).href };
    const steps = raw.split(/\s*(?:>|›|»|→)\s*/).map((s) => s.trim()).filter(Boolean);
    return { raw, steps };
  });
}

function slug(s, max = 40) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length <= max) return s;
  // Cut at a word boundary; a single word longer than max is cut at max.
  const cut = s.slice(0, max + 1);
  const i = cut.lastIndexOf('-');
  return (i > 0 ? cut.slice(0, i) : s.slice(0, max)).replace(/-+$/, '');
}

/** "Welcome - Realize Your Potential: Site Name" -> "Welcome". */
function titleName(t) {
  return String(t || '').split(/\s+[-–—|]\s+|:\s+/)[0].trim();
}

// ── Page helpers ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, stepMs = 400) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(stepMs);
  }
}

/** First visible element matching selector, searching every frame. */
async function findVisible(page, selector) {
  for (const frame of page.frames()) {
    const loc = frame.locator(selector);
    const n = Math.min(await loc.count().catch(() => 0), 25);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) return el;
    }
  }
  return null;
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  for (const f of page.frames()) await f.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await page.waitForTimeout(600);
}

/** Clicks the sign-in / next / continue control next to a field, or returns false. */
async function clickSubmitNear(field) {
  const handle = await field.elementHandle();
  const btn = (await handle.evaluateHandle((f) => {
    const scope = f.form || f.closest('form') || f.ownerDocument;
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const label = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const RE = /^(sign\s?in|log\s?in|login|sign\s?on|log\s?on|continue|next|submit|go)$/i;
    const list = [...scope.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')].filter(vis);
    return list.find((b) => RE.test(label(b))) || list.find((b) => b.type === 'submit') || null;
  })).asElement();
  if (!btn) return false;
  await btn.click({ timeout: 10000 });
  return true;
}

async function signIn(page, username, password) {
  let passEl = await waitFor(() => findVisible(page, PASS_SEL), 8000);
  if (!passEl) {
    // Username first, password on the next step.
    const userEl = await waitFor(() => findVisible(page, USER_SEL), 12000);
    if (!userEl) throw new CaptureError('No sign-in form was found at the environment address.');
    await userEl.fill(username);
    if (!(await clickSubmitNear(userEl))) await userEl.press('Enter');
    passEl = await waitFor(() => findVisible(page, PASS_SEL), 20000);
    if (!passEl) throw new CaptureError('After the username, no password field appeared. The site may use single sign-on, which this version cannot complete.');
  } else {
    const handle = await passEl.elementHandle();
    const userEl = (await handle.evaluateHandle((p) => {
      const all = [...(p.form || p.ownerDocument).querySelectorAll('input')];
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const before = all.slice(0, Math.max(0, all.indexOf(p)));
      const c = before.filter((e) => /^(text|email|tel|)$/i.test(e.getAttribute('type') || '') && vis(e) && !e.readOnly && !e.disabled);
      return c[c.length - 1] || null;
    })).asElement();
    if (userEl) await userEl.fill(username);
  }
  await passEl.fill(password);
  if (!(await clickSubmitNear(passEl))) await passEl.press('Enter');
  const gone = await waitFor(async () => !(await findVisible(page, PASS_SEL)), 30000);
  await settle(page);
  if (!gone || (await findVisible(page, PASS_SEL))) {
    throw new CaptureError('Sign-in did not complete. Check the username and password.');
  }
  const mfa = await findVisible(page, 'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="verification" i], input[id*="verification" i]');
  if (mfa) throw new CaptureError('The site asked for a verification code after sign-in. This version cannot complete two-step sign-in.');
}

async function onSignInPage(page) {
  return !!(await findVisible(page, PASS_SEL));
}

/** First visible, safe control whose name is the step text. Exact match first, then contains. */
async function findStep(page, text) {
  const esc = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = new RegExp('^\\s*' + esc + '\\s*$', 'i');
  const loose = new RegExp(esc, 'i');
  const roles = ['link', 'menuitem', 'tab', 'treeitem', 'button', 'option'];
  for (const name of [exact, loose]) {
    for (const frame of page.frames()) {
      const candidates = roles.map((role) => frame.getByRole(role, { name })).concat([frame.getByText(name)]);
      for (const loc of candidates) {
        const n = Math.min(await loc.count().catch(() => 0), 10);
        for (let i = 0; i < n; i++) {
          const el = loc.nth(i);
          if (!(await el.isVisible().catch(() => false))) continue;
          const label = ((await el.innerText().catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || '').trim();
          if (DANGER.test(label)) continue;
          return el;
        }
      }
    }
  }
  return null;
}

/**
 * Opens a collapsed menu: a visible button or link named like a menu or
 * navigation control (for example the three-line button) that is not already
 * open. Returns true if one was clicked.
 */
async function openMenus(page, tried) {
  const SEL = [
    '[aria-label*="menu" i]', '[aria-label*="navigation" i]', '[title*="menu" i]', '[title*="navigation" i]',
    '[aria-haspopup="true"][aria-expanded="false"]', 'button[aria-expanded="false"][aria-controls]',
    '.hamburger', '.navbar-toggler', '.menu-toggle', '[class*="hamburger" i]',
  ].join(', ');
  for (const frame of page.frames()) {
    const loc = frame.locator(SEL);
    const n = Math.min(await loc.count().catch(() => 0), 15);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      if ((await el.getAttribute('aria-expanded').catch(() => null)) === 'true') continue;
      const tag = await el.evaluate((e) => e.tagName).catch(() => '');
      if (!/^(BUTTON|A|DIV|SPAN|LI|I|SVG)$/i.test(tag)) continue;
      const label = ((await el.getAttribute('aria-label').catch(() => '')) || (await el.getAttribute('title').catch(() => '')) || (await el.innerText().catch(() => '')) || '').trim();
      if (DANGER.test(label)) continue;
      const key = frame.url() + '|' + i + '|' + label;
      if (tried.has(key)) continue;
      tried.add(key);
      await safeClick(el).catch(() => {});
      await page.waitForTimeout(800);
      return true;
    }
  }
  return false;
}

/**
 * Clicks one menu step by its visible name. If the step is not visible, opens
 * the site's collapsed menu controls one at a time and looks again.
 */
async function clickStep(page, text) {
  if (DANGER.test(text)) throw new CaptureError('"' + text + '" could change data, so it was not clicked.');
  let el = await findStep(page, text);
  const tried = new Set();
  for (let i = 0; !el && i < 4; i++) {
    if (!(await openMenus(page, tried))) break;
    el = await findStep(page, text);
  }
  if (!el) throw new CaptureError('Could not find "' + text + '" on the page.');
  await el.hover({ timeout: 3000 }).catch(() => {});
  await safeClick(el);
  await settle(page);
}

/**
 * Clicks an element that has already passed the safety checks. If something
 * on the page sits over it and the normal click times out, the element is
 * clicked directly instead.
 */
async function safeClick(el) {
  try { await el.click({ timeout: 6000 }); return; } catch (_) {}
  await el.evaluate((e) => e.click());
}

/** Closes stray dialogs and toasts, blurs focus, moves the pointer away, scrolls to top. */
async function cleanPage(page, size) {
  await page.keyboard.press('Escape').catch(() => {});
  const containers = ['[role=dialog]', '[role=alertdialog]', '[aria-modal="true"]', '.modal', '.toast', '[role=status]'];
  const closers = ['button[aria-label*="close" i]', 'button[aria-label*="dismiss" i]', '[role=button][aria-label*="close" i]',
    'button[title*="close" i]', 'button:has-text("Close")', 'button:has-text("Dismiss")', 'button:has-text("Got it")',
    'button:has-text("No thanks")', 'button:has-text("Not now")', 'button:has-text("×")'];
  for (let round = 0; round < 3; round++) {
    let closed = false;
    for (const c of containers) {
      const el = await findVisible(page, closers.map((x) => c + ' ' + x).join(', '));
      if (el) { await el.click({ timeout: 3000 }).catch(() => {}); closed = true; await page.waitForTimeout(400); break; }
    }
    if (!closed) break;
  }
  for (const f of page.frames()) {
    await f.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); window.scrollTo(0, 0); }).catch(() => {});
  }
  await page.mouse.move(size.width - 2, size.height - 2).catch(() => {});
  await page.waitForTimeout(300);
}

/** Replaces email addresses, phone numbers and the user's own words on screen. */
function maskInPage(words) {
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const PHONE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g;
  const extra = (words || []).filter(Boolean).map((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
  let count = 0;
  const maskText = (s) => {
    let t = s.replace(EMAIL, () => { count++; return 'user@example.com'; });
    t = t.replace(PHONE, (m) => {
      const d = m.replace(/\D/g, '').length;
      if (d < 10 || d > 15) return m;
      count++;
      return '(555) 555-0100';
    });
    for (const re of extra) t = t.replace(re, (m) => { count++; return '•'.repeat(Math.min(m.length, 12)); });
    return t;
  };
  const walk = (root) => {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (tw.nextNode()) nodes.push(tw.currentNode);
    for (const n of nodes) {
      const p = n.parentElement;
      if (p && /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) continue;
      const v = maskText(n.nodeValue);
      if (v !== n.nodeValue) n.nodeValue = v;
    }
    for (const el of root.querySelectorAll('input, textarea')) {
      if (el.type === 'password' || el.type === 'hidden') continue;
      const v = maskText(el.value || '');
      if (v !== el.value) el.value = v;
    }
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  if (document.body) walk(document.body);
  return count;
}

/** What is on screen: title, headings, labels and controls inside the viewport. */
function factsInPage() {
  const vis = (el) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' &&
      r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const txt = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || el.title || '')
    .replace(/\s+/g, ' ').trim().slice(0, 80);
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  const all = (sel) => [...document.querySelectorAll(sel)].filter(vis);
  const kind = (el) => {
    const role = el.getAttribute('role');
    if (role) return role;
    if (el.tagName === 'A') return 'link';
    if (el.tagName === 'SELECT') return 'dropdown';
    if (el.tagName === 'TEXTAREA') return 'text area';
    if (el.tagName === 'INPUT') return /^(checkbox|radio)$/.test(el.type) ? el.type : el.type === 'search' ? 'search box' : 'text field';
    return 'button';
  };
  const fieldName = (el) => {
    if (el.labels && el.labels[0]) return txt(el.labels[0]);
    return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '';
  };
  const active = document.querySelector('[aria-current="page"], [aria-current="true"], nav .active, nav .on, nav .selected, [role=navigation] .active, [role=navigation] [aria-selected="true"]');
  const CHROME = 'nav, header, aside, footer, [role=navigation], [role=banner], [role=contentinfo], [role=complementary]';
  const inChrome = (el) => !!el.closest(CHROME);
  const ctl = all('button, [role=button], a[href], [role=tab], [role=menuitem], input:not([type=hidden]), select, textarea, .btn, [onclick]')
    .filter((el, i, arr) => !arr.some((o) => o !== el && o.contains(el)));
  const label = (el) => { const name = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? fieldName(el) : txt(el); return name ? kind(el) + ': ' + String(name).slice(0, 60) : ''; };
  // Controls in the page body first, then navigation and header controls.
  const controls = ctl.filter((el) => !inChrome(el)).map(label).concat(ctl.filter(inChrome).map(label));
  // Text in the page body inside the viewport, to tell a loaded page from an empty one.
  let bodyText = 0;
  const tw = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  while (tw.nextNode()) {
    const p = tw.currentNode.parentElement;
    if (!p || inChrome(p) || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName) || !vis(p)) continue;
    bodyText += tw.currentNode.nodeValue.replace(/\s+/g, '').length;
    if (bodyText > 200) break;
  }
  return {
    title: document.title || '',
    h1: (all('h1, [role=heading][aria-level="1"]').map(txt).filter(Boolean)[0]) || '',
    headings: uniq(all('h1, h2, h3, [role=heading]').map(txt)).slice(0, 12),
    labels: uniq(all('label, th, legend, dt').map(txt)).slice(0, 25),
    controls: uniq(controls).slice(0, 30),
    active_nav: active && vis(active) ? txt(active).replace(/(\s+\d+)+$/, '').trim() : '',
    body_text: bodyText,
  };
}

async function maskPage(page, words) {
  let n = 0;
  for (const f of page.frames()) n += (await f.evaluate(maskInPage, words).catch(() => 0)) || 0;
  return n;
}

async function pageFacts(page) {
  const merged = { title: '', h1: '', headings: [], labels: [], controls: [], active_nav: '', body_text: 0 };
  for (const f of page.frames()) {
    const x = await f.evaluate(factsInPage).catch(() => null);
    if (!x) continue;
    if (f === page.mainFrame()) merged.title = x.title;
    merged.h1 = merged.h1 || x.h1;
    merged.active_nav = merged.active_nav || x.active_nav;
    merged.body_text += x.body_text || 0;
    for (const k of ['headings', 'labels', 'controls']) merged[k] = [...new Set(merged[k].concat(x[k]))];
  }
  merged.headings = merged.headings.slice(0, 12);
  merged.labels = merged.labels.slice(0, 25);
  merged.controls = merged.controls.slice(0, 30);
  return merged;
}

function cleanSourceUrl(u) {
  try { const x = new URL(u); return x.origin + x.pathname; } catch (_) { return ''; }
}

// ── Job ────────────────────────────────────────────────────────────────────

/**
 * Runs one capture job. job is mutated as it goes so a status call sees
 * progress. creds is read here and nowhere else; it is never logged.
 */
async function runCapture(job, creds, outDir) {
  const size = job.size;
  const words = job.mask_words || [];
  const envUrl = new URL(job.environment_url);
  const allowedHosts = new Set([envUrl.host]);
  const used = new Set();
  let popup = false;
  // guard: on after the first sign-in. acting: true only while the service
  // itself is signing in, opening a listed page or clicking a safe menu step.
  const state = { guard: false, acting: false };
  let page = null;
  let debugN = 0;

  /** Records where the browser is: site and path only, never query strings. */
  const note = async (step) => {
    if (!page || job.trace.length >= 200) return;
    job.trace.push({ step, url: cleanSourceUrl(page.url()), title: (await page.title().catch(() => '')).slice(0, 120) });
  };
  /** Saves a masked screenshot of the page as it is, for the user to see why something failed. */
  const debugShot = async () => {
    try {
      if (!page || debugN >= 20) return '';
      await maskPage(page, words);
      const name = 'debug-' + (++debugN) + '.png';
      fs.mkdirSync(path.join(outDir, '_debug'), { recursive: true });
      fs.writeFileSync(path.join(outDir, '_debug', name), await page.screenshot({ type: 'png' }));
      return name;
    } catch (_) { return ''; }
  };
  const acting = async (fn) => { state.acting = true; try { return await fn(); } finally { state.acting = false; } };
  const signInUnguarded = async () => {
    const was = state.guard;
    state.guard = false;
    try { await acting(() => signIn(page, creds.username, creds.password)); } finally { state.guard = was; }
  };

  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  try {
    const ua = (await browser.newPage().then(async (p) => { const v = await p.evaluate(() => navigator.userAgent); await p.close(); return v; }))
      .replace('HeadlessChrome', 'Chrome');
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1,
      userAgent: ua, locale: 'en-US', acceptDownloads: false,
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    context.on('page', (p) => { if (p !== page) { popup = true; p.close().catch(() => {}); } });
    page.on('dialog', (d) => d.dismiss().catch(() => {}));

    // After the first sign-in the browser refuses requests that change data:
    // DELETE, PUT and PATCH always; a form post that loads a new page only
    // when the service itself is not acting (a page posting on its own).
    // Older web apps move between pages with form posts, so those are allowed
    // while the service opens a listed page or clicks a safe menu step.
    await context.route('**/*', (route) => {
      const r = route.request();
      const m = r.method();
      const write = m === 'DELETE' || m === 'PUT' || m === 'PATCH';
      const postNav = m === 'POST' && r.isNavigationRequest() && !state.acting;
      if (state.guard && (write || postNav)) {
        job.blocked_requests++;
        if (job.blocked.length < 20) job.blocked.push(m + ' ' + cleanSourceUrl(r.url()));
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });

    job.stage = 'signing in';
    const hasCreds = !!(creds.username || creds.password);
    try {
      await acting(async () => {
        await page.goto(job.environment_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await settle(page);
      });
      await note('opened environment');
      if (hasCreds) await signInUnguarded();
    } catch (e) {
      await note('sign-in failed');
      job.debug_image = await debugShot();
      throw e;
    }
    const home = page.url();
    allowedHosts.add(new URL(home).host);
    await note('signed in');
    state.guard = true;

    // "/" or the environment address itself means the page reached after sign-in.
    const isHome = (t) => t.raw === '/' || (t.url && t.url.replace(/\/+$/, '') === job.environment_url.replace(/\/+$/, ''));
    const open = async (t) => {
      await acting(async () => {
        if (t.url) {
          await page.goto(isHome(t) ? home : t.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await settle(page);
        } else {
          await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await settle(page);
          for (const s of t.steps) {
            await clickStep(page, s);
            await note('clicked "' + s + '"');
            if (popup) throw new CaptureError('"' + s + '" opens a new window, which this version does not capture.');
          }
        }
      });
      await note('opened ' + t.raw);
    };

    job.stage = 'capturing';
    for (const t of job.targets) {
      job.progress.current = t.raw;
      try {
        popup = false;
        if (t.url) {
          const u = new URL(t.url);
          if (!allowedHosts.has(u.host)) throw new CaptureError('This address is on a different site from the environment, so it was not opened.');
          if (DANGER.test(decodeURIComponent(u.pathname + ' ' + u.search).replace(/[-_/]+/g, ' '))) throw new CaptureError('This address looks like it could change data, so it was not opened.');
        } else {
          for (const s of t.steps) if (DANGER.test(s)) throw new CaptureError('"' + s + '" could change data, so it was not clicked.');
        }
        await open(t);
        if (hasCreds && (await onSignInPage(page))) {
          // Session ended mid-run: sign in once more, then retry this target.
          await note('found sign-in page');
          await signInUnguarded();
          await open(t);
          if (await onSignInPage(page)) throw new CaptureError('The site showed its sign-in page again after signing in. The session could not be kept.');
        }
        if (!allowedHosts.has(new URL(page.url()).host)) throw new CaptureError('This step left the environment for another site, so it was not captured.');

        await cleanPage(page, size);
        let facts = await pageFacts(page);
        if (facts.body_text < 40) {
          // Looks empty: give a slow page more time once before capturing.
          await page.waitForTimeout(4000);
          await settle(page);
          await cleanPage(page, size);
        }
        job.masked += await maskPage(page, words);
        facts = await pageFacts(page);
        const warning = facts.body_text < 40 ? 'The page looked empty when it was captured. Check this image.' : '';

        // Names come from what the user typed where possible: a menu path
        // names both module and screen. A web address takes the module from
        // the highlighted menu item and the screen from the page heading.
        const urlPath = new URL(page.url()).pathname.split('/').filter(Boolean);
        const home_ = isHome(t);
        const moduleName = home_ ? 'Home' : t.steps ? t.steps[0] : (facts.active_nav || urlPath[0] || 'general');
        const screenName = home_ ? 'Home' : t.steps ? t.steps[t.steps.length - 1]
          : (facts.h1 || titleName(facts.title) || urlPath[urlPath.length - 1] || 'page');
        const folder = slug(moduleName) || 'general';
        let base = [slug(job.product, 30) || 'product', folder, slug(screenName) || 'page'].join('_');
        let filename = base + '.png';
        for (let i = 2; used.has(folder + '/' + filename); i++) filename = base + '-' + i + '.png';
        used.add(folder + '/' + filename);

        const buf = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', caret: 'hide' });
        const dim = png.dimensions(buf);
        if (dim.width !== size.width || dim.height !== size.height) {
          throw new CaptureError('The screenshot came out at ' + dim.width + 'x' + dim.height + ' instead of ' + size.width + 'x' + size.height + '.');
        }
        fs.mkdirSync(path.join(outDir, folder), { recursive: true });
        fs.writeFileSync(path.join(outDir, folder, filename), buf);

        job.screens.push({
          folder, filename, module: moduleName, screen: screenName, target: t.raw,
          page_title: facts.title, heading: facts.h1, headings: facts.headings, labels: facts.labels,
          elements: facts.controls, source_url: cleanSourceUrl(page.url()), warning,
        });
      } catch (e) {
        const refused = e.userMessage && /could change data|different site/.test(e.userMessage);
        const entry = { target: t.raw, reason: e.userMessage || ('The page could not be captured: ' + String(e.message || e).split('\n')[0].slice(0, 200)) };
        if (!refused) { await note('failed ' + t.raw); entry.debug_image = await debugShot(); }
        job.not_captured.push(entry);
      }
      job.progress.done++;
    }
    job.progress.current = '';
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { runCapture, parseTargets, parseSize, slug, CaptureError, DANGER };
