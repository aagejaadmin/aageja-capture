'use strict';
/**
 * Browser side of a capture job: sign in, visit each target or walk the
 * product, clean the page, mask personal details, read what is on screen,
 * take the screenshot.
 *
 * What the service does on the site, and what it does not:
 *   - The only typing is the username and password at sign-in.
 *   - What it clicks depends on the level the person chose (walk.js):
 *     links (menus, tabs and links), buttons (also buttons, dialogs and
 *     forms, left without saving) or all (also buttons that change data).
 *     At every level it never signs out, pays, or acts as another user.
 *   - Below the "all" level, menu steps, links and buttons whose words could
 *     change data are refused before anything is clicked or opened, and after
 *     sign-in the browser refuses DELETE, PUT and PATCH requests, form posts
 *     that load a new page when the service did not start them, and any
 *     request that would write data whatever sent it (writesData below: its
 *     address, a GraphQL mutation, an ASP.NET event, a JSON action). Every
 *     refused request is listed in the run report.
 *   - Pages still make their own background requests, as they do for any
 *     person viewing them. Every one that is not a plain read (GET) is
 *     recorded and listed in the run report.
 *   - New windows a click opens are closed, not followed.
 *   - Requests to addresses that are not on the public internet (this
 *     machine, private networks, cloud-internal names) are refused.
 */

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const png = require('./png-meta');
const W = require('./walk');
const { discoverControls } = require('./discover_controls');

const DANGER = /\b(delete|remove|deactivate|disable|archive|purge|reset|revoke|terminate|sign\s?out|sign\s?off|log\s?out|log\s?off|logout|logoff|signout|save|submit|approve|reject|decline|send|publish|unpublish|pay|purchase|buy|checkout|import|upload|assign|unassign|enrol+|register|request|launch|confirm)\b/i;
const PASS_SEL = 'input[type="password"]';
const USER_SEL = [
  'input[type="email"]', 'input[autocomplete="username"]',
  'input[name*="user" i]', 'input[id*="user" i]', 'input[name*="login" i]', 'input[id*="login" i]',
  'input[name*="email" i]', 'input[id*="email" i]', 'input[type="text"]', 'input:not([type])',
].join(', ');
const MAX_TARGETS = 50;
// The walk: screenshots per run, states tried, clicks from one page, and time.
// CAPTURE_MAX_SCREENS: a test machine only, to try the limit and Continue with a few screens.
const MAX_SCREENS = Number(process.env.CAPTURE_MAX_SCREENS) || 100;
const MAX_STATES = 600;
const MAX_CLICKS = 4;
const WALK_MS = 45 * 60 * 1000;
const LEVELS = ['links', 'buttons', 'all'];

class CaptureError extends Error {
  constructor(message) { super(message); this.userMessage = message; }
}

/** A screen the walk did not open, and why: window, site, gone, signin, changed. */
class Skip extends Error {
  constructor(why, label) { super(why); this.why = why; this.label = label || ''; }
}

/** The same masking as on screen, for names the run report repeats. */
function maskString(s, words) {
  let t = String(s || '').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'user@example.com');
  t = t.replace(/(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g, (m) => {
    const d = m.replace(/\D/g, '').length;
    return d < 10 || d > 15 ? m : '(555) 555-0100';
  });
  for (const w of words || []) if (w) t = t.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => '•'.repeat(Math.min(m.length, 12)));
  return t;
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
  // No pages listed: the walk captures the product from the page after sign-in.
  if (!lines.length) return [];
  if (lines.length > MAX_TARGETS) throw new CaptureError('List at most ' + MAX_TARGETS + ' pages in one run');
  return lines.map((raw) => {
    if (/^https?:\/\//i.test(raw)) return { raw, url: raw };
    if (raw.startsWith('/')) return { raw, url: new URL(raw, environmentUrl).href };
    const steps = raw.split(/\s*(?:>|›|»|→)\s*/).map((s) => s.trim()).filter(Boolean);
    return { raw, steps };
  });
}

function slug(s, max = 40) {
  s = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length <= max) return s;
  // Cut at a word boundary; a single word longer than max is cut at max.
  const cut = s.slice(0, max + 1);
  const i = cut.lastIndexOf('-');
  return (i > 0 ? cut.slice(0, i) : s.slice(0, max)).replace(/-+$/, '');
}

/** "Welcome - Realize Your Potential: Site Name" -> "Welcome". */
function titleName(t) {
  return String(t || '').split(/\s+[-–—|·•»]\s+|:\s+/)[0].trim();
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
  // A page that draws its content a moment after loading: look again for up to 10 seconds.
  let el = await waitFor(() => findStep(page, text), 10000, 700);
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

/**
 * Closes stray dialogs and toasts, blurs focus, moves the pointer away, scrolls
 * to top. With keepOpen (the last step opened a menu or panel without leaving
 * the page) only the scroll is done, so what the step opened stays in the shot.
 */
async function cleanPage(page, size, keepOpen) {
  if (keepOpen) {
    for (const f of page.frames()) await f.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForTimeout(500);
    return;
  }
  await page.keyboard.press('Escape').catch(() => {});
  const containers = ['[role=dialog]', '[role=alertdialog]', '[aria-modal="true"]', '.modal', '.toast', '[role=status]'];
  const closers = ['button[aria-label*="close" i]', 'button[aria-label*="dismiss" i]', '[role=button][aria-label*="close" i]',
    'button[title*="close" i]', 'button:has-text("Close")', 'button:has-text("Dismiss")', 'button:has-text("Got it")',
    'button:has-text("No thanks")', 'button:has-text("Not now")', 'button:has-text("×")'];
  // Only a close button on screen: one in a panel kept off to the side of the
  // page cannot be clicked and would stop the real pop-up being closed.
  const onScreen = async (selector) => {
    for (const frame of page.frames()) {
      const loc = frame.locator(selector);
      const n = Math.min(await loc.count().catch(() => 0), 25);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        const b = await el.boundingBox().catch(() => null);
        if (b && b.x + b.width > 0 && b.y + b.height > 0 && b.x < size.width && b.y < size.height) return el;
      }
    }
    return null;
  };
  for (let round = 0; round < 3; round++) {
    let closed = false;
    for (const c of containers) {
      const el = await onScreen(closers.map((x) => c + ' ' + x).join(', '));
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

/**
 * Waits until the page has finished drawing: no visible loading indicators
 * (skeleton or shimmer bars, spinners, loaders, progress bars, busy regions)
 * and the on-screen text unchanged across three checks a second apart, or
 * only cycling (a carousel). Gives up after maxMs. Returns true (still
 * loading) only when a loading indicator is still on screen: text that keeps
 * changing with no indicator (a live feed, a clock) is not loading.
 * A class counts only as a whole word between - or _ ("spinner",
 * "is-loading"), so "content-uploader" or "loaded" do not.
 */
async function waitForQuiet(page, maxMs = 12000) {
  const probe = () => {
    const SEL = '[aria-busy="true"], [role=progressbar], [class*="skeleton" i], [class*="shimmer" i], [class*="spinner" i], [class*="loader" i], [class*="loading" i]';
    const WORD = /(^|[-_])(skeleton|shimmer|spinner|loader|loading|preloader)([-_]|$)/i;
    const DONE = /(^|[-_])(done|complete|completed|loaded|finished|hidden|hide)([-_]|$)/i;
    const loaderClass = (el) => {
      // A progress bar showing a value (a course's "0%") is not loading; one with no value is.
      if (el.matches('[aria-busy="true"]') || (el.matches('[role=progressbar]') && !el.hasAttribute('aria-valuenow'))) return true;
      const tokens = (el.getAttribute('class') || '').split(/\s+/);
      return tokens.some((t) => WORD.test(t)) && !tokens.some((t) => DONE.test(t));
    };
    const vis = (el) => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 &&
        r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    };
    // Inside open shadow roots (web components) too.
    const all = [];
    const roots = [];
    const visit = (p) => { for (const el of p.children) { all.push(el); if (el.shadowRoot) { roots.push(el.shadowRoot); visit(el.shadowRoot); } visit(el); } };
    visit(document);
    let busy = 0;
    for (const el of all) {
      if (!el.matches(SEL)) continue;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'IMG') continue;
      if (loaderClass(el) && vis(el)) busy++;
    }
    let text = (document.body ? document.body.innerText : '').length;
    for (const r of roots) {
      const tw = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      while (tw.nextNode()) { const p = tw.currentNode.parentElement; if (!p || !/^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) text += tw.currentNode.nodeValue.trim().length; }
    }
    return { busy, text };
  };
  const sample = async () => {
    let busy = 0, text = 0;
    for (const f of page.frames()) {
      const x = await f.evaluate(probe).catch(() => null);
      if (x) { busy += x.busy; text += x.text; }
    }
    return { busy, text };
  };
  const end = Date.now() + maxMs;
  let last = null, same = 0, s = null, n = 0;
  const lengths = new Set();
  while (Date.now() < end) {
    s = await sample();
    n++;
    same = last && s.text === last.text ? same + 1 : 0;
    if (s.busy === 0 && same >= 2) return false;
    // Text back to a length already seen, with nothing loading: a carousel.
    if (s.busy === 0 && n >= 3 && last && s.text !== last.text && lengths.has(s.text)) return false;
    lengths.add(s.text);
    last = s;
    await page.waitForTimeout(1000);
  }
  return !!(s && s.busy > 0);
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
  // The page title is saved with the screenshot, so it is masked too.
  if (document.title) { const v = maskText(document.title); if (v !== document.title) document.title = v; }
  return count;
}

/**
 * What is on screen: title, headings, labels and controls inside the
 * viewport. With arg.dialog, only what is in the open dialog, so the
 * description is of the dialog and not the page behind it.
 */
function factsInPage(arg) {
  // Inside open shadow roots (web components) too; on a page with none, every
  // result is the same as a plain query.
  const below = (node) => {
    const out = [];
    const visit = (p) => { for (const el of p.children) { out.push(el); if (el.shadowRoot) visit(el.shadowRoot); visit(el); } };
    visit(node);
    return out;
  };
  const qsa = (sel, scope) => below(scope || document).filter((e) => e.matches(sel));
  const up = (e) => e.parentElement || (e.parentNode && e.parentNode.host) || null;
  const closest = (e, sel) => { for (let x = e; x; x = up(x)) if (x.matches(sel)) return x; return null; };
  const within = (a, e) => { for (let x = up(e); x; x = up(x)) if (x === a) return true; return false; };
  const vis = (el) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' &&
      r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const txt = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || el.title || '')
    .replace(/\s+/g, ' ').trim().slice(0, 80);
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  // A heading is the screen's name only when it is seen: not one hidden for
  // screen readers (a pixel square, clipped, or transparent).
  const seen = (el) => {
    if (!vis(el)) return false;
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    if (r.width <= 2 || r.height <= 2 || Number(s.opacity) <= 0.05) return false;
    if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(s.clip || '')) return false;
    if (/inset\(\s*(50|100)%/.test(s.clipPath || '')) return false;
    return true;
  };
  const DLG = '[role=dialog], [role=alertdialog], dialog[open], [aria-modal="true"], .modal.show, .modal.in, .ui-dialog, .k-window, .ReactModal__Content';
  const top = arg && arg.dialog ? qsa(DLG).filter(vis).pop() || null : null;
  const all = (sel) => qsa(sel, top).filter(vis);
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
  // The first, in document order, of: the current page's item, or an item
  // marked active, on or selected inside the navigation.
  const active = qsa('[aria-current="page"], [aria-current="true"], .active, .on, .selected, [aria-selected="true"]').find((e) =>
    e.matches('[aria-current="page"], [aria-current="true"]') ||
    (e.matches('.active, .on, .selected') && up(e) && closest(up(e), 'nav')) ||
    (e.matches('.active, [aria-selected="true"]') && up(e) && closest(up(e), '[role=navigation]'))) || null;
  const CHROME = 'nav, header, aside, footer, [role=navigation], [role=banner], [role=contentinfo], [role=complementary]';
  const inChrome = (el) => !!closest(el, CHROME);
  const ctl = all('button, [role=button], a[href], [role=tab], [role=menuitem], input:not([type=hidden]), select, textarea, .btn, [onclick]')
    .filter((el, i, arr) => !arr.some((o) => o !== el && within(o, el)));
  const label = (el) => { const name = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? fieldName(el) : txt(el); return name ? kind(el) + ': ' + String(name).slice(0, 60) : ''; };
  // Controls in the page body first, then navigation and header controls.
  const controls = ctl.filter((el) => !inChrome(el)).map(label).concat(ctl.filter(inChrome).map(label));
  // Text in the page body inside the viewport, to tell a loaded page from an empty one.
  let bodyText = 0;
  const textRoot = top || document.body || document.documentElement;
  // The page's own text first, then each shadow root's.
  for (const r of [textRoot].concat(below(textRoot).filter((e) => e.shadowRoot).map((e) => e.shadowRoot))) {
    const tw = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
    while (tw.nextNode()) {
      const p = tw.currentNode.parentElement;
      if (!p || inChrome(p) || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName) || !vis(p)) continue;
      bodyText += tw.currentNode.nodeValue.replace(/\s+/g, '').length;
      if (bodyText > 200) break;
    }
    if (bodyText > 200) break;
  }
  // The biggest bold text in the top half of the screen, outside the site's
  // header and menus: the screen's title where it is not marked as a heading
  // (Cornerstone's "Expert validation" is plain 28-pixel bold text).
  let big = '';
  if (!top && document.body) {
    let best = 0, bestTop = Infinity;
    for (const el of qsa('div, span, p, strong, b, label, legend, td', document.body)) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(' ').replace(/\s+/g, ' ').trim();
      if (own.length < 3 || own.length > 60 || inChrome(el) || closest(el, 'a, button, [role=button], [role=link], [role=tab], [role=menuitem]')) continue;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.top > innerHeight / 2 || !seen(el)) continue;
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize) || 0;
      if (!(size >= 20 || (size >= 18 && Number(cs.fontWeight) >= 600))) continue;
      if (size > best || (size === best && r.top < bestTop)) { best = size; bestTop = r.top; big = own; }
    }
  }
  return {
    big,
    title: document.title || '',
    h1: (all(top ? 'h1, h2, h3, h4, [role=heading], .modal-title, .ui-dialog-title' : 'h1, [role=heading][aria-level="1"]').filter(seen).map(txt).filter(Boolean)[0]) || '',
    headings: uniq(all('h1, h2, h3, [role=heading]').filter(seen).map(txt)).slice(0, 12),
    labels: uniq(all('label, th, legend, dt').map(txt)).slice(0, 25),
    controls: uniq(controls).slice(0, 60),
    active_nav: active && vis(active) ? txt(active).replace(/(\s+\d+)+$/, '').trim() : '',
    body_text: bodyText,
  };
}

async function maskPage(page, words) {
  let n = 0;
  for (const f of page.frames()) n += (await f.evaluate(maskInPage, words).catch(() => 0)) || 0;
  return n;
}

async function pageFacts(page, opts) {
  const merged = { title: '', h1: '', big: '', headings: [], labels: [], controls: [], active_nav: '', body_text: 0 };
  for (const f of page.frames()) {
    const x = await f.evaluate(factsInPage, opts || null).catch(() => null);
    if (!x) continue;
    if (f === page.mainFrame()) merged.title = x.title;
    merged.h1 = merged.h1 || x.h1;
    merged.big = merged.big || x.big || '';
    merged.active_nav = merged.active_nav || x.active_nav;
    merged.body_text += x.body_text || 0;
    for (const k of ['headings', 'labels', 'controls']) merged[k] = [...new Set(merged[k].concat(x[k]))];
  }
  merged.headings = merged.headings.slice(0, 12);
  merged.labels = merged.labels.slice(0, 25);
  merged.controls = merged.controls.slice(0, 60);
  return merged;
}

function cleanSourceUrl(u) {
  try { const x = new URL(u); return x.origin + x.pathname; } catch (_) { return ''; }
}

/**
 * A screen opened by a control on another screen: "Day view", not "Events
 * Calendar Day view", when the parent screen is the area itself; otherwise
 * "Bio – Transcript".
 */
function childName(module, parent, label) {
  const l = String(label || '').replace(/[▾▼▴▲▸▶◂◀⌄⌃]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!l) return parent;
  return !parent || String(parent).toLowerCase() === String(module || '').toLowerCase() ? l : parent + ' – ' + l;
}

/**
 * An area (folder) name from a menu or link label: no leading action word
 * ("Open: …", "Complete: …") and no dates ("Due Date 1/3/2026").
 */
function areaName(t) {
  const x = String(t || '')
    .replace(/[▾▼▴▲▸▶◂◀⌄⌃›»]+/g, ' ')
    .replace(/^\s*(open|view|complete|start|continue|launch|go\s+to|resume|review)\s*:\s*/i, '')
    .replace(/\b(due(\s+date)?|due\s+by|on|by)?\s*\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/gi, '')
    .replace(/\s+/g, ' ').trim();
  return x.length <= 60 ? x : x.slice(0, 60).replace(/\s+\S*$/, '');
}

/** Path only, no site and no query string: what a saved library may record. */
function pathOnly(u) {
  try { return new URL(u).pathname; } catch (_) { return ''; }
}

// ── Requests that would write data ─────────────────────────────────────────
// Below the "all" level these are refused whatever sent them, a control the
// walk judged safe or the page's own script (Cornerstone's Unfollow and Like
// were links with no address, and wrote through POST requests). Reads that
// many sites send as POST (search, GraphQL queries, analytics) go through.

// Words split out of an address, an event name or an operation name:
// "unfollowTrainingBFF" -> "unfollow Training BFF", "PostChangesV4" -> "Post Changes V4".
const splitWords = (t) => String(t || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/[-_/.$:=&?,;+%]+/g, ' ');
const WRITE = /\b(delete|remove|unfollow|follow|unlike|like|favou?rite|unfavou?rite|bookmark|unbookmark|vote|upvote|downvote|rate|save|update|upsert|create|insert|submit|approve|reject|decline|assign|unassign|enrol+|enroll|archive|unarchive|execute|publish|unpublish|send|upload|import|withdraw|cancel|mark|add|set|join|pin|unpin|post\s+changes|change\s+status|move|copy|merge|reset|revoke|deactivate|activate|complete)\b/i;
// Words that look like writes but read: "auto complete" (search suggestions).
const READ_PHRASE = /\bauto\s+complete\b/gi;

/** The reason a request would write data, or ''. */
function writesData(r) {
  const m = r.method();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return '';
  if (m === 'DELETE' || m === 'PUT' || m === 'PATCH') return m;
  let u;
  try { u = new URL(r.url()); } catch (_) { return ''; }
  const words = (t) => splitWords(t).replace(READ_PHRASE, ' ');
  let p = u.pathname;
  try { p = decodeURIComponent(p); } catch (_) {}
  if (WRITE.test(words(p))) return 'address';
  const q = [...u.searchParams].map(([k, v]) => /^(action|op|operation|method|cmd|command|do|mode)$/i.test(k) ? v : '').join(' ');
  if (WRITE.test(words(q))) return 'address';
  const body = (r.postData() || '').slice(0, 20000);
  if (!body) return '';
  // GraphQL: a mutation is a write, a query is a read.
  if (/graphql/i.test(p) || /"query"\s*:/.test(body)) {
    let ops = [];
    try { const j = JSON.parse(body); ops = Array.isArray(j) ? j : [j]; } catch (_) {}
    for (const o of ops) {
      if (o && typeof o.query === 'string' && /^\s*(#[^\n]*\n\s*)*mutation\b/.test(o.query)) return 'mutation';
      if (o && typeof o.query === 'string' && /\bmutation\s+[A-Za-z_]/.test(o.query) && !/\bquery\s+[A-Za-z_{(]/.test(o.query)) return 'mutation';
      if (o && !o.query && o.operationName && WRITE.test(words(o.operationName))) return 'mutation';
    }
    if (!ops.length && /\bmutation\b/.test(body)) return 'mutation';
    return '';
  }
  // ASP.NET: the control that posted back is named in __EVENTTARGET.
  if (/__EVENTTARGET=/.test(body)) {
    let f;
    try { f = new URLSearchParams(body); } catch (_) { f = null; }
    const ev = f ? (f.get('__EVENTTARGET') || '') + ' ' + (f.get('__EVENTARGUMENT') || '') : '';
    const btn = f ? [...f.keys()].filter((k) => /(btn|button|lnk|link|cmd)/i.test(k)).join(' ') : '';
    if (WRITE.test(words(ev)) || WRITE.test(words(btn))) return 'event';
    return '';
  }
  // JSON with an action field: { "action": "follow" }.
  if (/^\s*[{[]/.test(body)) {
    let j = null;
    try { j = JSON.parse(body); } catch (_) {}
    const one = Array.isArray(j) ? j[0] : j;
    if (one && typeof one === 'object') {
      const act = ['action', 'op', 'operation', 'method', 'command', 'type'].map((k) => (typeof one[k] === 'string' ? one[k] : '')).join(' ');
      if (WRITE.test(words(act))) return 'action';
    }
  }
  return '';
}

// ── Addresses that are not on the public internet ──────────────────────────

const ALLOW_LOCAL = process.env.CAPTURE_ALLOW_LOCAL === '1';

/** True for an IP address on this machine, a private network or a reserved range. */
function isPrivateIp(ip) {
  const v = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const m4 = v.replace(/^::ffff:/, '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m4) {
    const [a, b] = [Number(m4[1]), Number(m4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (!v.includes(':')) return false;
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}

/** True for a host name the browser must never reach: this machine or an internal network. */
function isInternalName(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (/^[\d.]+$/.test(h) || h.includes(':')) return isPrivateIp(h);
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local') || !h.includes('.');
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
  // A run that continues an earlier walk (job.resume) keeps its file names and sites.
  const used = new Set(job.resume ? job.resume.used : []);
  const level = LEVELS.includes(job.click_level) ? job.click_level : 'links';
  const t0 = Date.now();
  const masker = (s) => maskString(s, words);
  let popup = false;
  // guard: on after the first sign-in. acting: true only while the service
  // itself is signing in, opening a page or clicking. acceptDialogs: true
  // only while the "all" level presses a button that changes data, so the
  // site's own "Are you sure?" box is answered yes.
  // probe: true while the buttons level clicks a data-changing button to see
  // its "Are you sure?" box; every request but a plain read is then refused,
  // and so is loading another page.
  const state = { guard: false, acting: false, acceptDialogs: false, probe: false };
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
      // A failed sign-in leaves the username in its field: clear every typed value first.
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('input, textarea')) {
          if (!/^(hidden|checkbox|radio|submit|button|image|reset)$/i.test(el.type || '')) el.value = '';
        }
      }).catch(() => {});
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
    // Leaving a page is always allowed; anything else the browser asks is
    // answered no, except while the "all" level presses a data-changing button.
    page.on('dialog', (d) => ((d.type() === 'beforeunload' || state.acceptDialogs) ? d.accept() : d.dismiss()).catch(() => {}));

    // Addresses that are not on the public internet are refused at all times.
    // After the first sign-in, below the "all" level, the browser also refuses
    // every request that would write data (writesData: DELETE, PUT, PATCH, or
    // a POST whose address, GraphQL mutation, ASP.NET event or JSON action
    // says so), and a form post that loads a new page when the service itself is not
    // acting (a page posting on its own). Older web apps move between pages
    // with form posts, so those are allowed while the service opens a listed
    // page or clicks a safe menu step. Every other request that is not a plain
    // read is let through, recorded, and listed in the run report.
    const seen = new Set();
    const refusedSeen = new Set((job.blocked || []).map((x) => x.split(' (')[0]));
    await context.route('**/*', (route) => {
      const r = route.request();
      const m = r.method();
      let host = '';
      try { host = new URL(r.url()).hostname; } catch (_) {}
      if (!ALLOW_LOCAL && /^https?:/i.test(r.url()) && isInternalName(host)) {
        job.blocked_requests++;
        if (job.blocked.length < 20) job.blocked.push(m + ' ' + cleanSourceUrl(r.url()) + ' (not a public address)');
        return route.abort('blockedbyclient');
      }
      if (state.probe && (r.isNavigationRequest() || (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS'))) {
        job.blocked_requests++;
        const k = m + ' ' + pathOnly(r.url());
        if (!refusedSeen.has(k) && job.blocked.length < 200) { refusedSeen.add(k); job.blocked.push(k); }
        return route.abort('blockedbyclient');
      }
      const write = state.guard && level !== 'all' ? writesData(r) : '';
      const postNav = m === 'POST' && r.isNavigationRequest() && !state.acting;
      // The "all" level was chosen to change data: nothing is refused but
      // addresses off the public internet.
      if (state.guard && level !== 'all' && (write || postNav)) {
        job.blocked_requests++;
        const k = m + ' ' + pathOnly(r.url());
        if (!refusedSeen.has(k) && job.blocked.length < 200) { refusedSeen.add(k); job.blocked.push(k); }
        return route.abort('blockedbyclient');
      }
      // A form post the service's own menu click started is not the page's doing.
      if (state.guard && m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && !(r.isNavigationRequest() && state.acting)) {
        job.background_requests++;
        const k = m + ' ' + pathOnly(r.url());
        if (!seen.has(k)) { seen.add(k); job.background_kinds = (job.background_kinds || 0) + 1; if (job.background.length < 60) job.background.push(k); }
      }
      return route.continue();
    });

    job.stage = 'signing in';
    const hasCreds = !!(creds.username || creds.password);
    let opened = '';
    try {
      await acting(async () => {
        await page.goto(job.environment_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await settle(page);
      });
      opened = page.url();
      await note('opened environment');
      if (hasCreds) await signInUnguarded();
      else if (await onSignInPage(page)) {
        throw new CaptureError('The address opened a sign-in page. Enter the username and password for the environment.');
      }
    } catch (e) {
      await note('sign-in failed');
      job.debug_image = await debugShot();
      throw e;
    }
    let home = page.url();
    allowedHosts.add(new URL(home).host);
    if (job.resume) for (const h of job.resume.hosts || []) allowedHosts.add(h);
    await note('signed in');
    state.guard = true;

    // Where the capture starts. The site's root address or its sign-in page
    // (the sign-in form was at the address itself, or the address is named
    // like one) means the page reached after sign-in, as before. Any other
    // address is a page inside the product (the site sent the browser
    // elsewhere to sign in, or no sign-in was needed): it is opened after
    // sign-in, and with no pages listed only addresses under its folder are
    // captured (scope), if it opened there.
    const pathKey = (u) => { try { const x = new URL(u); return x.host.toLowerCase() + x.pathname.replace(/\/+$/, '').toLowerCase(); } catch (_) { return ''; } };
    const entered = new URL(job.environment_url);
    const atRoot = entered.pathname.replace(/\/+$/, '') === '';
    const signInHere = (hasCreds && pathKey(opened) === pathKey(entered.href)) ||
      /(^|[/_.-])(log-?in|log-?on|sign-?in|sign-?on|sso|auth)([/_.-]|$)/i.test(entered.pathname);
    const startHere = !atRoot && !signInHere && !job.resume;
    if (startHere && pathKey(home) !== pathKey(entered.href)) {
      const openEntered = () => acting(async () => {
        await page.goto(entered.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await settle(page);
      });
      try {
        await openEntered();
        if (hasCreds && (await onSignInPage(page))) {
          await signInUnguarded();
          await openEntered();
        }
      } catch (e) {
        if (e instanceof CaptureError) throw e;
        throw new CaptureError('After sign-in, the URL you entered did not open. Check that it opens in a browser once you are signed in.');
      }
      if (hasCreds && (await onSignInPage(page))) throw new CaptureError('After sign-in, the URL you entered showed the sign-in page again. Check that it opens in a browser once you are signed in.');
      await note('opened the URL entered');
      home = page.url();
      allowedHosts.add(new URL(home).host);
    }
    // The folder of the URL entered: /app/x/ for /app/x/home, and
    // /reports/ for /reports when it opened /reports/overview. The root is no
    // limit. A run that continues an earlier one keeps that run's folder.
    // A URL that opened somewhere else (the site sent it on to its home page)
    // is no limit.
    let scope = job.resume ? (job.resume.scope || null) : null;
    if (startHere && !job.targets.length) {
      const ep = entered.pathname;
      const hp = new URL(home).pathname;
      const dir = ep.endsWith('/') ? ep
        : hp.toLowerCase().startsWith(ep.toLowerCase() + '/') ? ep + '/'
        : ep.slice(0, ep.lastIndexOf('/') + 1);
      const there = new URL(home).host.toLowerCase() === entered.host.toLowerCase() && hp.toLowerCase().startsWith(dir.toLowerCase());
      if (dir && dir !== '/' && there) scope = { host: new URL(home).host, path: dir };
    }
    const inScope = (u) => {
      if (!scope) return true;
      try { const x = new URL(u); return x.host === scope.host && x.pathname.toLowerCase().startsWith(scope.path.toLowerCase()); } catch (_) { return false; }
    };
    // The site's own words in every tab title ("Welcome - Realize Your
    // Potential: Cornerstone University"): a page whose title is only these
    // is named by what it shows instead.
    const siteWords = new Set(String(await page.title().catch(() => '')).split(/\s+[-–—|·•»]\s+|:\s+/).slice(1).map((x) => x.trim().toLowerCase()).filter(Boolean));
    const nameFromTitle = (t) => { const n = titleName(t); return n && !siteWords.has(n.toLowerCase()) ? n : ''; };

    // "/" or the environment address itself means the page reached after sign-in.
    const isHome = (t) => t.raw === '/' || (t.url && t.url.replace(/\/+$/, '') === job.environment_url.replace(/\/+$/, ''));
    // Returns true when the last menu step opened something without leaving
    // the page (a menu, panel or tab), so clean-up leaves it open.
    const open = async (t) => {
      let keepOpen = false;
      await acting(async () => {
        if (t.url) {
          await page.goto(isHome(t) ? home : t.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await settle(page);
        } else {
          await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await settle(page);
          for (let i = 0; i < t.steps.length; i++) {
            const before = page.url();
            // Clear stray pop-ups once, before the first click. Cleaning between
            // steps would close a menu the previous step opened.
            if (i === 0) await cleanPage(page, size, false);
            await clickStep(page, t.steps[i]);
            await note('clicked "' + t.steps[i] + '"');
            if (popup) throw new CaptureError('"' + t.steps[i] + '" opens a new window, which this version does not capture.');
            if (i === t.steps.length - 1) keepOpen = page.url() === before;
          }
        }
      });
      await note('opened ' + t.raw);
      return keepOpen;
    };

    /** Saves a screenshot of the page as it is now and records the screen. */
    const shoot = async ({ moduleName, screenName, target, facts, warning, reached }) => {
      const folder = slug(moduleName) || 'general';
      const base = [slug(job.product, 30) || 'product', folder, slug(screenName) || 'page'].join('_');
      let filename = base + '.png';
      for (let i = 2; used.has(folder + '/' + filename); i++) filename = base + '-' + i + '.png';
      const buf = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', caret: 'hide' });
      const dim = png.dimensions(buf);
      if (dim.width !== size.width || dim.height !== size.height) {
        throw new CaptureError('The screenshot came out at ' + dim.width + 'x' + dim.height + ' instead of ' + size.width + 'x' + size.height + '.');
      }
      used.add(folder + '/' + filename);
      fs.mkdirSync(path.join(outDir, folder), { recursive: true });
      fs.writeFileSync(path.join(outDir, folder, filename), buf);
      // A smaller copy for the PDF catalog only; never in the zip or served.
      try {
        const jpg = await page.screenshot({ type: 'jpeg', quality: 75, fullPage: false, animations: 'disabled', caret: 'hide' });
        fs.mkdirSync(path.join(outDir, '_thumbs', folder), { recursive: true });
        fs.writeFileSync(path.join(outDir, '_thumbs', folder, filename.replace(/\.png$/, '.jpg')), jpg);
      } catch (_) {}
      job.screens.push({
        folder, filename, module: moduleName, screen: screenName, target,
        page_title: facts.title, heading: facts.h1, headings: facts.headings, labels: facts.labels,
        elements: facts.controls, source_path: pathOnly(page.url()), warning,
        ...(reached ? { reached_by: reached } : {}),
      });
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
        let keepOpen = await open(t);
        if (hasCreds && (await onSignInPage(page))) {
          // Session ended mid-run: sign in once more, then retry this target.
          await note('found sign-in page');
          await signInUnguarded();
          keepOpen = await open(t);
          if (await onSignInPage(page)) throw new CaptureError('The site showed its sign-in page again after signing in. The session could not be kept.');
        }
        if (!allowedHosts.has(new URL(page.url()).host)) throw new CaptureError('This step left the environment for another site, so it was not captured.');

        const stillLoading = await waitForQuiet(page);
        await cleanPage(page, size, keepOpen);
        let facts = await pageFacts(page);
        if (facts.body_text < 40) {
          // Looks empty: give a slow page more time once before capturing.
          await page.waitForTimeout(4000);
          await settle(page);
          await cleanPage(page, size, keepOpen);
        }
        facts = await pageFacts(page);
        // A listed page that shows the site's error message is not kept: it
        // goes in Not captured, and the walk opens nothing on it.
        if (W.ERROR_PAGE.test([facts.h1, facts.title, ...(facts.headings || []).slice(0, 3)].join(' | '))) {
          throw new CaptureError('The page showed the site\'s error message, so it was not kept.');
        }
        job.masked += await maskPage(page, words);
        facts = await pageFacts(page);
        const warning = facts.body_text < 40 ? 'The page looked empty when it was captured. Check this image.'
          : stillLoading ? 'The page was still loading after 12 seconds when it was captured. Check this image.' : '';

        // Names come from what the user typed where possible: a menu path
        // names both module and screen. A web address takes the module from
        // the highlighted menu item and the screen from the page heading.
        const urlPath = new URL(page.url()).pathname.split('/').filter(Boolean);
        const home_ = isHome(t);
        const moduleName = home_ ? 'Home' : t.steps ? t.steps[0] : (facts.active_nav || urlPath[0] || 'general');
        const screenName = home_ ? 'Home' : t.steps ? t.steps[t.steps.length - 1]
          : (facts.h1 || nameFromTitle(facts.title) || facts.big || urlPath[urlPath.length - 1] || 'page');
        await shoot({ moduleName, screenName, target: t.raw, facts, warning });
      } catch (e) {
        const refused = e.userMessage && /could change data|different site|error message/.test(e.userMessage);
        const entry = { target: t.raw, reason: e.userMessage || ('The page could not be captured: ' + String(e.message || e).split('\n')[0].slice(0, 200)) };
        if (!refused) { await note('failed ' + t.raw); entry.debug_image = await debugShot(); }
        job.not_captured.push(entry);
      }
      job.progress.done++;
    }
    job.progress.current = '';

    // ── The walk ───────────────────────────────────────────────────────────
    // With no pages listed, it walks the product from the page after sign-in.
    // With pages listed and the buttons or all level, it opens what is on
    // each listed page (buttons, tabs, dialogs) but follows no links.
    if (!job.targets.length || level !== 'links' || job.resume) {
      job.stage = 'capturing';
      const followLinks = !job.targets.length;
      const seeds = [];
      if (job.resume) { /* the earlier run's list of screens still to open */ }
      else if (followLinks) seeds.push({ base: home, actions: [], trail: [], parent: null, phase: 1, capture: true, home: true });
      else {
        for (const t of job.targets) {
          const shot = job.screens.find((s) => s.target === t.raw);
          if (!shot) continue;
          seeds.push({
            base: t.url ? (isHome(t) ? home : t.url) : home,
            actions: t.steps ? t.steps.map((s) => ({ step: s, label: s })) : [],
            trail: t.steps ? t.steps.slice() : [shot.screen], parent: null, phase: 1, capture: false,
            seed: { module: shot.module, screen: shot.screen },
          });
        }
      }
      job.walk = {
        level, mode: followLinks ? 'walk' : 'list', stopped: '', tried: 0, nochange: 0, gone: 0, failed: 0, left: 0,
        unnamed: 0, downloads: 0, same: 0, browse: 0, repeats: {}, errors: {}, never: {}, change: {}, confirmed: {}, window: {}, site: {}, pressed: {},
        scope: scope ? scope.path : '', outside: 0,
      };
      await walkFrom(seeds, followLinks);
    }

    /**
     * Breadth first: every screen one click or link from the start, then two,
     * and so on. Data-changing buttons (the all level) wait in a second queue
     * until everything else is done, so a Delete never removes a screen before
     * it is captured. A screen is the page's kind of address (record numbers
     * replaced), its open dialog and its chosen tabs; the same screen for
     * another record is not captured again.
     */
    async function walkFrom(seeds, followLinks) {
      const w = job.walk;
      // Each name once: the same Sign out on every page is one entry.
      // A label for the report: screen-reader notes dropped, cut at a word.
      const short = (t) => {
        const x = String(t).replace(/[,(\s]*\(?\s*(this\s+link\s+)?opens?\s+(in\s+)?a\s+new\s+(window|tab)\s*\)?[.,\s]*/gi, ' ').replace(/\s+/g, ' ').trim();
        return x.length <= 60 ? x : x.slice(0, 60).replace(/\s+\S*$/, '') + '…';
      };
      const tally = (bucket, label) => { const k = short(masker(label || '(no name)')) || '(no name)'; bucket[k] = 1; };
      // Continuing an earlier walk: what it saw is seen, what it left is the queue.
      const R = job.resume || {};
      const seenFp = new Set(R.seenFp || []);
      // What is on each captured screen (its content summary): the same content
      // under another address (Home and Welcome) is not captured twice.
      const seenSig = new Set(R.seenSig || []);
      const seenPat = new Set(R.seenPat || []);
      const keys = new Set(R.keys || []);
      const downloads = new Set(R.downloads || []);
      // Addresses outside the folder of the URL entered, each kind once.
      const outside = new Set();
      const q1 = [];
      const q2 = [];
      for (const s of seeds) q1.push(s);
      for (const s of R.q1 || []) q1.push(s);
      for (const s of R.q2 || []) q2.push(s);
      const pending = () => q1.length + q2.length;
      const progress = () => {
        job.progress.done = job.screens.length;
        job.progress.total = Math.max(job.progress.done, Math.min(MAX_SCREENS, job.screens.length + pending()));
      };
      const framePat = (f) => (f === page.mainFrame() ? 'main' : W.urlPattern(f.url()).pattern);
      const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

      const stateOf = async () => {
        const out = { dialog: '', tabs: '', h1: '', sig: '' };
        const sigs = [];
        for (const f of page.frames()) {
          const x = await f.evaluate(W.stateInPage).catch(() => null);
          if (!x) continue;
          out.dialog = out.dialog || x.dialog;
          out.tabs = [out.tabs, x.tabs].filter(Boolean).join('+');
          out.h1 = out.h1 || x.h1;
          sigs.push(x.sig);
        }
        out.sig = hash(sigs.join('#'));
        return out;
      };

      // Which document the page shows: a new one after every page load.
      const docId = () => page.evaluate(() => performance.timeOrigin).catch(() => 0);

      const findAction = async (a) => {
        const frames = page.frames();
        const ordered = frames.filter((f) => framePat(f) === a.frame).concat(frames.filter((f) => framePat(f) !== a.frame));
        for (const f of ordered) {
          const cands = ((await f.evaluate(discoverControls, { dialogOnly: true }).catch(() => null)) || { controls: [] }).controls;
          const c = cands.find((x) => !x.hidden && x.sel === a.sel && x.label === a.label) ||
            cands.find((x) => !x.hidden && x.label === a.label && x.kind === a.kind);
          if (c) return { c, loc: f.locator(c.sel).first() };
        }
        return null;
      };

      /** Opens the state's start page, then repeats its clicks in order. */
      const reach = async (st) => {
        popup = false;
        const go = () => acting(async () => {
          await page.goto(st.base, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await settle(page);
        });
        await go();
        if (await onSignInPage(page)) {
          if (!hasCreds) throw new Skip('signin');
          // The session ended (a timeout, or a link that signed out): sign in once more.
          await note('found sign-in page');
          await signInUnguarded();
          await go();
          if (await onSignInPage(page)) throw new CaptureError('The site showed its sign-in page again after signing in. The session could not be kept.');
        }
        if (!allowedHosts.has(new URL(page.url()).host)) throw new Skip('site', st.trail[st.trail.length - 1]);
        if (!st.home && !inScope(page.url())) throw new Skip('outside', page.url());
        if (!st.actions.length) return;
        await acting(async () => {
          await cleanPage(page, size, false);
          for (let i = 0; i < st.actions.length; i++) {
            const a = st.actions[i];
            const pressing = st.commit && i === st.actions.length - 1;
            const docBefore = await docId();
            if (a.step) await clickStep(page, a.step);
            else {
              // A page that draws its content a moment after loading: look again for up to 8 seconds.
              const found = await waitFor(() => findAction(a), 8000, 700);
              if (!found) throw new Skip('gone', a.label);
              // The last check before every click: the control on the page now
              // must pass this level's rules by its own name.
              const cls = W.classify(found.c);
              const probing = st.probe && i === st.actions.length - 1 && cls === 'commit';
              if (cls === 'never' || (!W.ALLOWED[level].has(cls) && !probing)) throw new Skip('changed', a.label);
              await found.loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
              await found.loc.hover({ timeout: 2000 }).catch(() => {});
              // A probe stays on until the visit ends: nothing the button
              // starts reaches the site, before or after its box is captured.
              if (probing) state.probe = true;
              state.acceptDialogs = pressing && level === 'all';
              try { await safeClick(found.loc); await settle(page); } finally { state.acceptDialogs = false; }
            }
            await note('clicked "' + masker(a.label || a.step) + '"');
            if (popup) throw new Skip('window', a.label || a.step);
            if (!allowedHosts.has(new URL(page.url()).host)) throw new Skip('site', a.label || a.step);
            if (!inScope(page.url())) throw new Skip('outside', page.url());
            // A click that loaded a page (a tab with its own address, even the
            // same one): that page's pop-ups are cleared, as on a page opened by
            // address, before the next click or the screenshot.
            if (!pressing && (await docId()) !== docBefore) {
              await waitForQuiet(page, 8000);
              await cleanPage(page, size, false);
            }
          }
        });
      };

      /**
       * The buttons level's probe of a data-changing button (the skill's
       * Constraint 5): if it opened an "Are you sure?" box, capture the box
       * and press Cancel. Nothing it sent reached the site.
       */
      const probeResult = async (st) => {
        const last = st.actions[st.actions.length - 1];
        await waitForQuiet(page, 5000);
        const s = await stateOf();
        const pat = W.urlPattern(page.url());
        const raw = pat.pattern + (s.dialog ? '|dlg:' + W.norm(s.dialog) : '') + (s.tabs ? '|tab:' + W.norm(s.tabs) : '');
        if (!s.dialog || (st.parent && raw === st.parent.raw.replace(/\|h1:.*$/, ''))) { tally(w.change, last.label); return; }
        const fp = raw + '>' + W.norm(last.label);
        if (seenFp.has(fp)) return;
        seenFp.add(fp);
        await page.mouse.move(size.width - 2, size.height - 2).catch(() => {});
        job.masked += await maskPage(page, words);
        const facts = await pageFacts(page, { dialog: true });
        const parentScreen = st.parent ? st.parent.screen : 'Home';
        const d = masker(s.dialog);
        await shoot({
          moduleName: st.parent ? st.parent.module : 'Home',
          screenName: d && d !== 'dialog' ? d : childName(st.parent ? st.parent.module : 'Home', parentScreen, masker(last.label) + ' confirmation'),
          facts, warning: '', target: masker(st.trail.join(' > ')),
          reached: masker(st.trail.join(' > ')) + ' (the box was then canceled)',
        });
        tally(w.confirmed, last.label);
        progress();
        // Cancel, never confirm.
        const found = (await page.mainFrame().evaluate(discoverControls, { dialogOnly: true }).catch(() => null)) || { controls: [] };
        const cancel = found.controls.find((c) => /^(cancel|no|close|dismiss|keep|go back|×|✕|✖|x)$/i.test(c.label || ''));
        if (cancel) await safeClick(page.locator(cancel.sel).first()).catch(() => {});
        else await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
      };

      const visit = async (st) => {
        await reach(st);
        if (st.probe) return probeResult(st);
        const last = st.actions[st.actions.length - 1];
        if (st.commit && last) tally(w.pressed, last.label);
        if (st.commit && !last) tally(w.pressed, st.trail[st.trail.length - 1]);
        const stillLoading = await waitForQuiet(page);
        if (!st.actions.length) await cleanPage(page, size, false);
        const s = await stateOf();
        const pat = W.urlPattern(page.url());
        const raw = pat.pattern + (s.dialog ? '|dlg:' + W.norm(s.dialog) : '') + (s.tabs ? '|tab:' + W.norm(s.tabs) : '') +
          (!pat.hasId && !s.dialog ? '|h1:' + W.norm(s.h1) : '');
        let fp = raw;
        if (st.parent && last && raw === st.parent.raw) {
          // Same page, same dialog: a new screen only if what is on it changed
          // (a menu, panel or wizard step opened).
          if (s.sig === st.parent.sig) { w.nochange++; return; }
          fp = st.parent.fp + '>' + W.norm(last.label);
        }
        if (seenFp.has(fp)) return;
        seenFp.add(fp);
        seenPat.add(pat.pattern);

        // The site's error page ("An error occurred while processing your
        // request") is not a screen: not kept, and nothing on it is opened.
        const heads = await page.evaluate(() => [...document.querySelectorAll('h1, h2, [role=heading]')].filter((e) => e.offsetParent !== null)
          .slice(0, 3).map((e) => (e.innerText || '').trim().slice(0, 120)).join(' | ')).catch(() => '');
        if (W.ERROR_PAGE.test([s.h1, s.dialog, await page.title().catch(() => ''), heads].join(' | '))) {
          tally(w.errors, st.trail.join(' > ') || 'Home');
          return;
        }
        // The same content as a screen already captured (Home and Welcome):
        // not kept again. Same means the same title, headings, labels and
        // controls, and the same text on screen, numbers aside.
        let same = s.sig;
        if (st.capture !== false) {
          const texts = [await page.title().catch(() => '')];
          for (const f of page.frames()) {
            texts.push(await f.evaluate(() => {
              let t = document.body ? document.body.innerText : '';
              // The text inside open shadow roots (web components), when there are any.
              const visit = (p) => {
                for (const el of p.children) {
                  if (el.shadowRoot) {
                    const tw = document.createTreeWalker(el.shadowRoot, NodeFilter.SHOW_TEXT);
                    while (tw.nextNode()) { const q = tw.currentNode.parentElement; if (!q || !/^(SCRIPT|STYLE|NOSCRIPT)$/.test(q.tagName)) t += ' ' + tw.currentNode.nodeValue; }
                    visit(el.shadowRoot);
                  }
                  visit(el);
                }
              };
              visit(document);
              return t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 20000);
            }).catch(() => ''));
          }
          same = hash(s.sig + '#' + texts.join('#'));
          if (seenSig.has(same)) { w.same++; return; }
        }

        // Controls, read before masking so a later visit finds them by the same name.
        const deep = st.actions.length < MAX_CLICKS;
        const cands = [];
        for (const f of page.frames()) {
          const fpat = framePat(f);
          const found = (await f.evaluate(discoverControls, { dialogOnly: true }).catch(() => null)) || { controls: [] };
          for (const c of found.controls) cands.push({ ...c, frame: fpat, cls: W.classify(c) });
        }

        const navigated = !st.parent || pat.pattern !== st.parent.pattern;
        let moduleName = st.seed ? st.seed.module : st.parent ? st.parent.module : 'Home';
        let screenName = st.seed ? st.seed.screen : 'Home';
        if (st.capture !== false && job.screens.length < MAX_SCREENS) {
          if (s.dialog) await page.mouse.move(size.width - 2, size.height - 2).catch(() => {});
          let facts = await pageFacts(page, { dialog: !!s.dialog });
          if (facts.body_text < 40 && !s.dialog) { await page.waitForTimeout(4000); await settle(page); }
          job.masked += await maskPage(page, words);
          facts = await pageFacts(page, { dialog: !!s.dialog });
          // A dialog is small by nature: only a page is checked for looking empty.
          const warning = facts.body_text < 40 && !s.dialog ? 'The page looked empty when it was captured. Check this image.'
            : stillLoading ? 'The page was still loading after 12 seconds when it was captured. Check this image.' : '';
          const urlPath = new URL(page.url()).pathname.split('/').filter(Boolean);
          const parentScreen = st.parent ? st.parent.screen : 'Home';
          if (st.home && !startHere) { moduleName = 'Home'; screenName = 'Home'; }
          else if (st.home) {
            // The URL entered: named by its highlighted menu item, else its heading.
            const a = areaName(facts.active_nav);
            moduleName = a || 'Home';
            screenName = a || facts.h1 || nameFromTitle(facts.title) || masker(facts.big) || 'Home';
          }
          else if (navigated && !s.dialog) {
            // The site's own area (the active menu item, else the menu section the
            // link sat in), else the first menu step.
            moduleName = areaName(facts.active_nav) || areaName(masker(st.section || '')) || areaName(masker((st.names || st.trail)[0] || '')) || urlPath[0] || 'general';
            // Every page is named by its own heading, as the page list names one.
            screenName = facts.h1 || nameFromTitle(facts.title) || masker(facts.big) || masker(st.trail[st.trail.length - 1] || '') || 'page';
            // A tab that loads its own page under the same heading ("Security",
            // tab Design-time) is named by the tab, like a tab that does not.
            if (last && last.kind === 'tab' && st.parent && W.norm(screenName) === W.norm(parentScreen)) {
              screenName = childName(moduleName, parentScreen, masker(last.label));
            }
          } else if (s.dialog) {
            const d = masker(s.dialog);
            screenName = d && d !== 'dialog' ? d : childName(moduleName, parentScreen, masker(last ? last.label : ''));
          } else screenName = childName(moduleName, parentScreen, masker(last ? last.label : ''));
          seenSig.add(same);
          await shoot({
            moduleName, screenName, facts, warning,
            target: masker(st.trail.join(' > ') || 'Home'),
            reached: masker(st.trail.join(' > ') || 'the page after sign-in'),
          });
          progress();
        }
        const node = { raw, fp, sig: s.sig, pattern: pat.pattern, module: moduleName, screen: screenName };

        // What to open next: navigation first, then tabs, other links, then buttons.
        const rank = (c) => (c.cls === 'commit' ? 9 : c.kind === 'link' && c.inNav ? 0 : c.kind === 'tab' ? 1 : c.kind === 'link' || c.kind === 'menuitem' ? 2 : c.cls === 'reveal' ? 3 : 4);
        cands.sort((a, b) => rank(a) - rank(b));
        // The same button on each item of a list or table: the first one stands
        // for the rest. Same means a label of the form "word: item" with the
        // same word ("Actions: Office Safety Test", "Follow: 5G Awareness"),
        // or the same place in the page, row aside, and the same first word
        // ("Approve Dan Jones" on each row). Buttons with the very same label
        // are already opened once. Links are not grouped: their addresses are.
        const firstWord = (c) => W.norm(c.label).split(/[\s:]+/)[0] || '';
        const prefix = (c) => { const m = /^([^:]{2,30}):\s+\S/.exec(String(c.label || '')); return m ? W.norm(m[1]) : ''; };
        const shapeOf = (c) => prefix(c) ? 'item|' + c.frame + '|' + c.kind + '|' + prefix(c)
          : c.frame + '|' + String(c.sel || '').replace(/:nth-of-type\(\d+\)/g, '').replace(/\d+/g, '#') + '|' + c.kind + '|' + firstWord(c);
        // A link with no address runs code like a button, so it is grouped like one.
        const listed = (c) => (c.kind !== 'link' || !c.href) && !c.inNav && !c.hidden && !!c.label;
        const shapeCount = new Map();
        for (const c of cands) if (listed(c)) shapeCount.set(shapeOf(c), (shapeCount.get(shapeOf(c)) || 0) + 1);
        const grouped = (c) => listed(c) && shapeCount.get(shapeOf(c)) >= (prefix(c) ? 2 : 3);
        const shapeOpened = new Set();
        // A picture that links to the same place as a named link (a course's
        // picture beside its title) is not a button with no name.
        const namedHrefs = new Set(cands.filter((c) => c.label && c.href).map((c) => c.href));
        for (const c of cands) {
          const cls = c.cls;
          if (cls === 'never') { if (!c.hidden) tally(w.never, c.label); continue; }
          if (cls === 'skip') { if (c.download || (c.href && W.FILE_EXT.test(c.href.split(/[?#]/)[0]))) downloads.add(c.href || c.label); continue; }
          if (cls === 'browse') { if (!c.hidden) w.browse++; continue; }
          if (cls === 'unnamed') { if (!c.hidden && !(c.href && namedHrefs.has(c.href))) w.unnamed++; continue; }
          if (grouped(c)) {
            if (shapeOpened.has(shapeOf(c))) {
              const k = masker(String(c.label).split(/[\s:]+/)[0]).slice(0, 40) || 'button';
              w.repeats[k] = (w.repeats[k] || 0) + 1;
              continue;
            }
            shapeOpened.add(shapeOf(c));
          }
          // The buttons level probes a data-changing button for its "Are you
          // sure?" box instead of skipping it. Never a link: following one is
          // a page load, and that is the change.
          // A toggle (Follow, Like, a pressed/not-pressed button) shows no box
          // to capture, so it is not probed.
          const toggle = W.TOGGLE.test(c.label || '') || (c.pressed != null && c.pressed !== '');
          const probe = level === 'buttons' && cls === 'commit' && !c.href && !toggle && !c.hidden && deep;
          if (!W.ALLOWED[level].has(cls) && !probe) { if (cls === 'commit' && !c.hidden) tally(w.change, c.label); continue; }
          const commit = cls === 'commit' && !probe;
          const phase = commit || st.phase === 2 ? 2 : 1;
          const q = phase === 2 ? q2 : q1;
          if (c.kind === 'link' && c.href) {
            if (!followLinks) continue;
            let h;
            try { h = new URL(c.href); } catch (_) { continue; }
            if (!/^https?:$/.test(h.protocol)) continue;
            if (!allowedHosts.has(h.host)) { if (!c.hidden) tally(w.site, c.label); continue; }
            if (!inScope(h.href)) { outside.add(W.urlPattern(h.href).pattern); continue; }
            const p = W.urlPattern(c.href).pattern;
            if (seenPat.has(p)) continue;
            seenPat.add(p);
            q.push({ base: c.href, actions: [], trail: st.trail.concat(c.label || ''), names: (st.names || st.trail).concat(c.label || ''), section: c.section || st.section || '', parent: node, phase, commit, capture: true });
          } else {
            if (c.hidden || !deep) continue;
            if (c.kind === 'link' && !followLinks) continue;
            // A control in the site's navigation (a menu button in the header)
            // is the same on every page: opened once for the whole walk.
            // A button that changes data is pressed once per screen, not once for
            // each tab chosen behind it (one password reset, not three).
            const keyBase = (cls === 'reveal' || c.inNav) && !s.dialog ? 'site-navigation'
              : cls === 'commit' && !s.dialog ? raw.replace(/\|tab:[^|]*/, '')
              : s.dialog || /^(next|continue)\b/i.test(c.label) ? fp : raw;
            const key = keyBase + '|' + c.kind + ':' + W.norm(c.label || c.hint);
            if (keys.has(key)) continue;
            keys.add(key);
            q.push({
              base: st.base, actions: st.actions.concat({ frame: c.frame, sel: c.sel, label: c.label, kind: c.kind }),
              trail: st.trail.concat(c.label || 'unnamed'), names: cls === 'reveal' ? (st.names || st.trail) : (st.names || st.trail).concat(c.label || 'unnamed'),
              section: c.section || st.section || '',
              parent: node, phase, commit, probe,
              capture: !(cls === 'reveal' && level === 'links'),
            });
          }
        }
        progress();
      };

      while (q1.length || q2.length) {
        if (job.screens.length >= MAX_SCREENS) { w.stopped = 'limit'; break; }
        if (Date.now() - t0 > WALK_MS) { w.stopped = 'time'; break; }
        if (w.tried >= MAX_STATES) { w.stopped = 'tries'; break; }
        const st = q1.length ? q1.shift() : q2.shift();
        w.tried++;
        job.progress.current = masker(st.trail.join(' > ') || 'Home');
        try {
          await visit(st);
        } catch (e) {
          state.probe = false;
          if (e instanceof Skip) {
            if (e.why === 'window') tally(w.window, e.label);
            else if (e.why === 'site') tally(w.site, e.label);
            else if (e.why === 'outside') outside.add(W.urlPattern(e.label).pattern);
            else w.gone++;
          } else if (e.userMessage && /could not be kept/.test(e.userMessage)) {
            w.stopped = 'session';
            job.not_captured.push({ target: masker(st.trail.join(' > ') || 'Home'), reason: e.userMessage });
            break;
          } else {
            w.failed++;
            if (job.not_captured.length < 30) {
              await note('failed ' + masker(st.trail.join(' > ')));
              job.not_captured.push({
                target: masker(st.trail.join(' > ') || 'Home'),
                reason: e.userMessage || ('The screen could not be captured: ' + String(e.message || e).split('\n')[0].slice(0, 160)),
                debug_image: await debugShot(),
              });
            }
          }
        }
        state.probe = false;
      }
      w.left = pending();
      w.downloads = downloads.size;
      w.outside = outside.size;
      // What a later run needs to carry on from here, kept with the job for its 24 hours.
      job.walkState = pending() ? {
        level, q1, q2, seenFp: [...seenFp], seenPat: [...seenPat], seenSig: [...seenSig], keys: [...keys], downloads: [...downloads],
        used: [...used], hosts: [...allowedHosts], scope,
      } : null;
      progress();
      job.progress.current = '';
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { runCapture, parseTargets, parseSize, slug, isPrivateIp, isInternalName, ALLOW_LOCAL, CaptureError, DANGER, LEVELS, MAX_SCREENS, maskString, writesData };
