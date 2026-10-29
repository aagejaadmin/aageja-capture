#!/usr/bin/env node
/**
 * AaGeJa Capture Service — v1.5.0 (October 2026)
 *
 * v1.5.0 — the walk: clicks through the product
 *   - targets may be blank: the service then walks the product from the page
 *     after sign-in, nearest screens first, up to 100 screenshots and 45
 *     minutes, and captures each screen it reaches. The same screen for
 *     another record (/users/123, /users/456) is captured once.
 *   - click_level (new) says what it clicks:
 *       links    menu items, tabs and links (the default)
 *       buttons  also buttons, ⋯ menus, dropdowns, accordions and wizard
 *                steps; each dialog and form is captured and left unsaved
 *       all      also buttons that change data (Save, Submit, Delete, Send
 *                and similar), pressed after everything else is captured.
 *                The browser then refuses nothing but addresses off the
 *                public internet, and answers the site's "Are you sure?" yes.
 *     At every level it never signs out, pays, or acts as another user.
 *   - With pages listed and the buttons or all level, it opens what is on
 *     each listed page (buttons, tabs, dialogs) and follows no links.
 *   - The run report says how the walk went: what it clicked, why it
 *     stopped, and what it did not click (would change data, never pressed,
 *     opens a new window, another site, buttons with no name).
 *   - The description step's answer is read even when it was cut off: every
 *     complete entry is kept.
 *   - Page titles are masked like the page text.
 *
 * v1.4.0 — signing in is optional
 *   - The username and password may both be left blank, for an address that
 *     opens the product without signing in (for example a link that carries
 *     its own access key). Then the service only opens the address. One
 *     without the other is refused.
 *   - With no username and password, an address that shows a sign-in page
 *     stops the run with "The address opened a sign-in page. Enter the
 *     username and password for the environment."
 *   - The saved library still records page paths only: a key in the
 *     address's query string is never written to library.json, the images'
 *     metadata or the run report.
 *
 * v1.3.0 — the library is kept here for 24 hours, nowhere else
 *   - Every library is kept by this service for RETENTION_HOURS (24) on links
 *     anyone with the link can open: library.json, each image, and a zip of
 *     everything. The links carry a 128-bit random token and stop working
 *     when the time is up. The customer downloads the zip and puts the
 *     screenshots in their own folder; the Storyboard Designer reads a GitHub,
 *     S3, Google Cloud Storage or web folder.
 *   - library.json lists each image by a link relative to itself
 *     ("home/x.png"), so it still works after the folder is uploaded anywhere.
 *     The zip adds a READ ME saying how.
 *   - Saving to GitHub is removed, with the library_folder field and the
 *     GITHUB_TOKEN variable. No account or key of AaGeJa's touches a
 *     customer's storage. (The GitHub, S3 and Google Cloud Storage saving
 *     built for 1.3.0 is kept on the capture-storage-options branch.)
 *
 * v1.2.0
 *   - The sign-in comes with each run: /capture/start takes environment_url,
 *     username and password. The Connect page and the environment connection
 *     token are removed.
 *   - The library is saved to the customer's own GitHub folder:
 *     library_folder is a github.com folder link in a public repository the
 *     capture service's GitHub account can write to. Checked before anything
 *     is captured. The house-repository list is removed.
 *   - Captured images are deleted from this service once the library is saved.
 *   - The saved library and image metadata record no environment address;
 *     each screen keeps its page path only (source_path).
 *   - Addresses that are not on the public internet are refused, both as the
 *     environment and for any request a page makes.
 *   - Background requests the pages make while loading (anything other than
 *     a plain read) are recorded and listed in the run report.
 *   - Preview images need the key, like every other capture route.
 *   - Errors from GitHub and from the service itself reach the caller as a
 *     plain message; the detail goes to the log.
 *   - File names longer than 40 characters per part are cut at a word
 *     boundary (the cut never ran in earlier versions).
 *
 * v1.1.0 — what the Screenshot Library Builder agent needs
 *   - Connect page and environment connection token (removed in v1.2.0).
 *   - /capture/start takes library_folder, checked before the capture starts,
 *     not after it.
 *   - /capture/status adds ai_input (each screen's page text, for the one AI
 *     step that writes descriptions) and report_md (what was not captured and
 *     what to check, ready to display).
 *   - /capture/finalize takes the AI step's output as the whole body, as
 *     plain text, and saves to the folder given at start. A body that is not
 *     readable JSON still saves, with descriptions built from the screen name.
 *     The response adds summary_md, ready to display.
 *
 * v1.0.6
 *   - Before each shot, waits up to 12 seconds until no loading indicator is
 *     on screen (placeholder bars, shimmer, spinners, progress bars, busy
 *     regions) and the page text is unchanged across three checks a second
 *     apart. A page still loading after that is captured and flagged. Found
 *     on a training environment's page captured with grey placeholder bars.
 *
 * v1.0.5
 *   - Stray pop-ups are cleared once, before the first menu click. v1.0.4
 *     cleared them before the last click, which pressed Escape and closed the
 *     menu the previous step had opened, so second-level items were not found.
 *
 * v1.0.4
 *   - When the last menu step opens something without leaving the page (a
 *     menu, panel or tab), it stays open in the shot. Stray pop-ups are
 *     cleared before that last click instead of after it.
 *   - Up to 60 on-screen controls are recorded per image (was 30).
 *
 * v1.0.3
 *   - A safe step whose normal click times out (something on the page sits
 *     over it) is clicked directly instead. Found on a site's menu button.
 *
 * v1.0.2
 *   - A menu step that is not visible opens the site's collapsed menu
 *     controls (for example the three-line button) one at a time and looks
 *     again, so "Admin > Users" works on sites that hide their menu.
 *   - The page reached after sign-in is named "home"; a page title such as
 *     "Welcome - Site Name" names the screen by its first part; long names are
 *     cut at a word boundary.
 *
 * v1.0.1 — first run against a real site (a customer training environment)
 *   - "/" or the environment address means the page reached after sign-in.
 *     On sites whose root address is the sign-in page, it had led back there.
 *   - A form post that loads a new page is allowed while the service opens a
 *     listed page or clicks a safe menu step, and still refused when a page
 *     posts on its own. Older web apps move between pages with form posts.
 *     DELETE, PUT and PATCH stay refused at all times after sign-in.
 *   - Status adds trace (each page visited: site and path only), blocked
 *     (requests refused) and a screenshot of each page that failed, for
 *     preview only. None of these are saved to the library.
 *
 * The server side of the Screenshot Library Builder agent. Runs a browser
 * with no screen (Playwright), separate from content-api so a browser's
 * memory use can never touch the content production routes.
 *
 *   GET  /health                          Status
 *   POST /capture/start                   Start a job              (key)
 *   GET  /capture/status/:id              Progress and results     (key)
 *   GET  /capture/image/:id/:folder/:file A captured image, for preview (key)
 *   POST /capture/finalize/:id            Descriptions in -> metadata,
 *                                         library.json, zip        (key)
 *   GET  /library/:token/...              The library, for 24 hours: library.json,
 *                                         screenshots.zip and each image
 *
 * Start a job, then check back: a capture outlives any single HTTP request.
 * One job runs at a time; others wait in order.
 *
 * Credentials. The username and password go into the browser and nowhere
 * else. They are not written to disk, not logged, not returned by any route,
 * and dropped when the job's browser closes.
 *
 * Environment variables:
 *   CAPTURE_KEY          Required. Callers send it as X-AaGeJa-Key. Unset
 *                        means every keyed route refuses.
 *   RETENTION_HOURS      Hours a job and its library are kept (default 24).
 *   WORK_DIR             Where images wait between capture and finalize
 *                        (default /tmp/capture).
 *   CAPTURE_ALLOW_LOCAL  Set to 1 only on a test machine: allows http:// and
 *                        local addresses. Never set it on Railway.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const { runCapture, parseTargets, parseSize, isPrivateIp, isInternalName, ALLOW_LOCAL, CaptureError, LEVELS } = require('./capture');
const png = require('./png-meta');
const zip = require('./zip');

const VERSION = '1.5.0';
const PORT = process.env.PORT || 3000;
const CAPTURE_KEY = process.env.CAPTURE_KEY || '';
const WORK_DIR = process.env.WORK_DIR || '/tmp/capture';
const RETENTION_HOURS = Number(process.env.RETENTION_HOURS) || 24;
const RETENTION_MS = RETENTION_HOURS * 3600 * 1000;

fs.mkdirSync(WORK_DIR, { recursive: true });

const jobs = new Map();
const shares = new Map();   // library token -> job id
const queue = [];
let running = null;

// ── Helpers ────────────────────────────────────────────────────────────────

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new CaptureError('Request body is too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch (_) { throw new CaptureError('Request body is not valid JSON'); }
}

function keyOk(req) {
  if (!CAPTURE_KEY) return false;
  const got = Buffer.from(String(req.headers['x-aageja-key'] || ''));
  const want = Buffer.from(CAPTURE_KEY);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return proto + '://' + req.headers.host;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Accepts an array, { images: [...] }, or the same as text (with or without
 * code fences or words around it). Anything unreadable gives [] and every
 * screen falls back to a description built from its screen name.
 */
function parseDescriptions(v) {
  let x = v;
  if (typeof x === 'string') {
    const s = x.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    if (!s) return [];
    x = null;
    try { x = JSON.parse(s); } catch (_) {
      const a = s.indexOf('['), b = s.lastIndexOf(']');
      if (a > -1 && b > a) { try { x = JSON.parse(s.slice(a, b + 1)); } catch (_) { x = null; } }
    }
  }
  if (x && !Array.isArray(x)) x = x.images || x.screens || x.descriptions || [];
  if (Array.isArray(x)) return x;
  // An answer cut off part way (a long library): keep every complete entry.
  if (typeof v === 'string') {
    const out = [];
    for (const m of v.match(/\{[^{}]*"filename"[^{}]*\}/g) || []) { try { out.push(JSON.parse(m)); } catch (_) {} }
    return out;
  }
  return [];
}

const mdCell = (t) => String(t || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/** "Admin > Users", or just "Home" when module and screen are the same. */
const screenLabel = (s) => (s.module && s.screen && s.module.toLowerCase() !== s.screen.toLowerCase() ? s.module + ' > ' + s.screen : (s.screen || s.target));

/** Each screen's page text, for the AI step that writes descriptions. */
function aiInput(job) {
  return job.screens.map((s, i) => [
    (i + 1) + '. filename: ' + s.filename,
    '   screen: ' + screenLabel(s),
    ...(s.reached_by ? ['   reached by: ' + s.reached_by] : []),
    '   page title: ' + (s.page_title || ''),
    '   headings: ' + (s.headings || []).join(' | '),
    '   labels: ' + (s.labels || []).slice(0, 20).join(' | '),
    '   controls: ' + (s.elements || []).slice(0, 25).join(' | '),
  ].join('\n')).join('\n\n');
}

const LEVEL_WORDS = {
  links: 'opened menu items, tabs and links',
  buttons: 'opened menu items, tabs, links, buttons and dialogs, and left every form without saving',
  all: 'opened menu items, tabs, links, buttons and dialogs, and pressed buttons that change data',
};

/** "Save (3), Delete user, Send" from { label: count }. */
function listOf(bucket, max = 12) {
  const e = Object.entries(bucket || {});
  return e.slice(0, max).map(([k, n]) => mdCell(k) + (n > 1 ? ' (' + n + ')' : '')).join(', ') +
    (e.length > max ? ', and ' + (e.length - max) + ' more' : '');
}

/** How the walk went, as Markdown. Empty when the run only captured a list of pages. */
function walkMd(job) {
  const w = job.walk;
  if (!w) return '';
  const n = job.screens.length;
  const out = ['**How the capture went through the product**', ''];
  out.push((w.mode === 'walk' ? 'Starting from the page after sign-in, it ' : 'On each page you listed, it ') + LEVEL_WORDS[w.level] +
    '. ' + n + ' screenshot' + (n === 1 ? '' : 's') + ' taken.');
  const left = w.left ? ' ' + w.left + ' more screen' + (w.left === 1 ? ' it found was' : 's it found were') + ' not opened. To capture them, run again with those pages listed.' : '';
  if (w.stopped === 'limit') out.push('', 'It stopped at the limit of 100 screenshots.' + left);
  else if (w.stopped === 'time') out.push('', 'It stopped after 45 minutes.' + left);
  else if (w.stopped === 'tries') out.push('', 'It stopped after trying 600 screens.' + left);
  else if (w.stopped === 'session') out.push('', 'It stopped because the site kept showing its sign-in page.');
  else out.push('', 'It opened every screen it found.');
  out.push('');
  if (w.level === 'all' && Object.keys(w.pressed).length) out.push('**Buttons pressed that change data:** ' + listOf(w.pressed, 30), '');
  const rows = [];
  if (w.level === 'links') rows.push('- **Buttons and dialogs:** not opened. Choose "Also open buttons and dialogs" to capture them.');
  if (w.level !== 'all' && Object.keys(w.change).length) rows.push('- **Would change data, so not pressed:** ' + listOf(w.change) + '. Choose "Also press buttons that change data" to include them.');
  if (Object.keys(w.never).length) rows.push('- **Never pressed:** ' + listOf(w.never) + '. Signing out, paying and acting as another user are never done.');
  if (Object.keys(w.window).length) rows.push('- **Open a new window, so not followed:** ' + listOf(w.window));
  if (Object.keys(w.site).length) rows.push('- **On another site, so not followed:** ' + listOf(w.site));
  if (w.unnamed) rows.push('- **Buttons with no name, so not clicked:** ' + w.unnamed);
  if (w.downloads) rows.push('- **Downloads, not opened:** ' + w.downloads);
  if (w.gone) rows.push('- **Could not be reached again:** ' + w.gone + ' (the page had changed since the control was found).');
  if (rows.length) out.push('**Not clicked**', '', ...rows, '');
  return out.join('\n');
}

/** What was not captured and what to check, as Markdown. Empty when there is nothing to report. */
function reportMd(job) {
  const out = [];
  const walk = walkMd(job);
  if (walk) out.push(walk);
  if (job.not_captured.length) {
    out.push('**Not captured**', '');
    for (const n of job.not_captured) out.push('- ' + mdCell(n.target) + ' — ' + mdCell(n.reason));
    out.push('');
  }
  const warn = job.screens.filter((s) => s.warning);
  if (warn.length) {
    out.push('**Check these screenshots**', '');
    for (const s of warn) out.push('- ' + mdCell(screenLabel(s)) + ' — ' + mdCell(s.warning));
    out.push('');
  }
  if (job.background_requests) {
    const nreq = job.background_requests + ' request' + (job.background_requests === 1 ? '' : 's');
    const lvl = job.walk ? job.walk.level : 'links';
    const intro = lvl === 'all'
      ? 'The capture pressed buttons that change data. While it worked, the pages sent ' + nreq + ' that were not plain reads:'
      : lvl === 'buttons'
        ? 'The capture opened pages, menus, buttons and dialogs and pressed no button that changes data. While it worked, the pages sent ' + nreq + ' that were not plain reads, as they do for anyone using them:'
        : 'The capture only opened pages and menu items. While they loaded, the pages themselves sent ' + nreq + ' that were not plain reads, as they do for anyone viewing them:';
    out.push(lvl === 'links' ? '**Requests the pages made while loading**' : '**Requests the pages made**', '', intro, '');
    for (const r of job.background) out.push('- ' + mdCell(r));
    if (job.background.length < job.background_requests) out.push('- (and repeats of these)');
    out.push('');
  }
  return out.join('\n');
}

function publicJob(job, req) {
  const b = baseUrl(req);
  return {
    job_id: job.id,
    status: job.status,
    stage: job.stage,
    queue_position: job.status === 'queued' ? queue.indexOf(job) + 1 : 0,
    progress: job.progress,
    product: job.product,
    client: job.client,
    click_level: job.click_level,
    mode: job.targets.length ? 'list' : 'walk',
    environment_url: job.environment_url,
    image_size: job.size.width + 'x' + job.size.height,
    captured_count: job.screens.length,
    not_captured_count: job.not_captured.length,
    masked_count: job.masked,
    blocked_requests: job.blocked_requests,
    background_requests: job.background_requests,
    screens: job.screens.map((s) => ({
      ...s,
      preview_url: b + '/capture/image/' + job.id + '/' + encodeURIComponent(s.folder) + '/' + encodeURIComponent(s.filename),
    })),
    not_captured: job.not_captured.map((n) => ({ ...n, ...(n.debug_image ? { debug_preview_url: b + '/capture/image/' + job.id + '/_debug/' + n.debug_image } : {}) })),
    error: job.error || null,
    ai_input: aiInput(job),
    report_md: reportMd(job),
    debug_preview_url: job.debug_image ? b + '/capture/image/' + job.id + '/_debug/' + job.debug_image : null,
    trace: job.trace,
    blocked: job.blocked,
    background: job.background,
    library: job.library || null,
  };
}

// ── Job runner ─────────────────────────────────────────────────────────────

async function pump() {
  if (running || !queue.length) return;
  const job = queue.shift();
  running = job;
  const creds = job._creds;
  delete job._creds;
  job.status = 'running';
  job.started = Date.now();
  console.log('[job ' + job.id + '] started: ' + (job.targets.length ? job.targets.length + ' target(s)' : 'walk') + ', clicking ' + job.click_level);
  try {
    await runCapture(job, creds, path.join(WORK_DIR, job.id));
    job.status = job.screens.length ? 'captured' : 'failed';
    if (!job.screens.length) job.error = 'No pages were captured. See the reasons listed for each page.';
  } catch (e) {
    job.status = 'failed';
    job.error = e.userMessage || ('The capture stopped: ' + String(e.message || e).split('\n')[0].slice(0, 200));
  } finally {
    creds.username = null;
    creds.password = null;
    job.stage = '';
    job.finished = Date.now();
    console.log('[job ' + job.id + '] ' + job.status + ': ' + job.screens.length + ' captured, ' + job.not_captured.length + ' not captured');
    running = null;
    setImmediate(pump);
  }
}

/** A job ends RETENTION_HOURS after it finished; a saved library, that long after it was saved. */
const jobEnds = (job) => job.expires || ((job.finished || job.created) + RETENTION_MS);

function purge() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job === running || job.status === 'queued') continue;
    if (jobEnds(job) < now) {
      fs.rmSync(path.join(WORK_DIR, id), { recursive: true, force: true });
      if (job.share) shares.delete(job.share);
      jobs.delete(id);
    }
  }
  for (const name of fs.readdirSync(WORK_DIR)) if (!jobs.has(name)) {
    const p = path.join(WORK_DIR, name);
    try { if (fs.statSync(p).mtimeMs < now - RETENTION_MS) fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
  }
}
setInterval(purge, 10 * 60 * 1000).unref();

// ── Routes ─────────────────────────────────────────────────────────────────

/** The environment must be a named site on the public internet. */
async function checkEnvironment(raw) {
  let env;
  try { env = new URL(String(raw || '').trim()); } catch (_) { throw new CaptureError('The environment address must be a full web address starting with https://'); }
  if (env.protocol !== 'https:' && !(ALLOW_LOCAL && env.protocol === 'http:')) throw new CaptureError('The environment address must start with https://');
  if (env.username || env.password) throw new CaptureError('Put the username and password in their own fields, not in the address.');
  if (ALLOW_LOCAL) return env;
  const host = env.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^[\d.]+$/.test(host) || host.includes(':')) throw new CaptureError('Use the environment\'s web address by name, not a numeric address.');
  if (isInternalName(host)) throw new CaptureError('This address is not on the public internet, so it cannot be captured.');
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (_) { throw new CaptureError('The environment address could not be found. Check it is typed correctly.'); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new CaptureError('This address is not on the public internet, so it cannot be captured.');
  return env;
}

async function start(req, res) {
  const body = parseJson(await readBody(req, 64 * 1024));
  const product = String(body.product || body.product_name || '').trim();
  const client = String(body.client || body.client_name || '').trim();
  const username = String(body.username || '');
  const password = String(body.password || '');
  if (!product) throw new CaptureError('Product name is required');
  // Both, or neither for an address that opens without signing in.
  if (!!username.trim() !== !!password) throw new CaptureError('Enter both the username and the password, or leave both blank if the address opens the product without signing in.');
  const env = await checkEnvironment(body.environment_url);
  // links (default), buttons or all. See the v1.5.0 notes.
  const clickLevel = String(body.click_level || 'links').trim().toLowerCase();
  if (!LEVELS.includes(clickLevel)) throw new CaptureError('Clicking must be links, buttons or all.');

  // No pages listed: the service walks the product.
  const targets = parseTargets(body.targets, env.href);
  const size = parseSize(body.image_size);
  const maskWords = (Array.isArray(body.mask_words) ? body.mask_words : String(body.mask_words || '').split(/[\n,]/))
    .map((s) => String(s).trim()).filter((s) => s.length >= 2).slice(0, 50);

  const id = crypto.randomBytes(12).toString('hex');
  const job = {
    id, status: 'queued', stage: '', created: Date.now(),
    product, client, environment_url: env.href, size, mask_words: maskWords, targets, click_level: clickLevel,
    progress: { done: 0, total: targets.length || 1, current: '' },
    screens: [], not_captured: [], masked: 0, blocked_requests: 0, blocked: [], trace: [], debug_image: '',
    background_requests: 0, background: [],
    _creds: { username, password },
  };
  jobs.set(id, job);
  queue.push(job);
  setImmediate(pump);
  send(res, 202, {
    job_id: id,
    status: job.status,
    queue_position: queue.indexOf(job) + 1,
    targets: targets.length,
    status_url: baseUrl(req) + '/capture/status/' + id,
  });
}

async function finalize(req, res, job) {
  // Saving twice returns the first save.
  if (job.status === 'done' && job.library) return send(res, 200, { ...job.library, images: job.library_rows || [], not_captured: job.not_captured.map((n) => ({ target: n.target, reason: n.reason })) });
  if (job.status !== 'captured') {
    throw new CaptureError(job.status === 'failed' ? 'This capture failed, so there is nothing to save.' : 'This capture is still running. Check its status first.');
  }
  // The body is the AI step's output as plain text (from the agent), or
  // { descriptions }.
  const raw = await readBody(req, 1024 * 1024);
  let body = null;
  try { body = JSON.parse(raw); } catch (_) { body = null; }
  const wrapped = body && typeof body === 'object' && !Array.isArray(body) && 'descriptions' in body;
  const share = crypto.randomBytes(16).toString('hex');
  const base = baseUrl(req) + '/library/' + share + '/';
  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

  const descs = parseDescriptions(wrapped ? body.descriptions : raw);
  const byName = new Map(descs.filter((d) => d && d.filename).map((d) => [String(d.filename).trim(), d]));
  const date = today();
  const dir = path.join(WORK_DIR, job.id);
  const files = [];
  const rows = [];
  let missing = 0;
  for (const s of job.screens) {
    const d = byName.get(s.filename) || {};
    if (!d.description) missing++;
    const fallback = s.module.toLowerCase() === s.screen.toLowerCase() ? s.screen : s.module + ' — ' + s.screen;
    const description = String(d.description || fallback).trim();
    const alt = String(d.alt || description).trim();
    const rel = s.folder + '/' + s.filename;
    const out = png.embed(fs.readFileSync(path.join(dir, s.folder, s.filename)), {
      Title: s.screen, Description: description, Alt: alt, Screen: s.module + ' > ' + s.screen,
      Source: s.source_path, Captured: date, Elements: s.elements.join('; '),
      Software: 'AaGeJa Screenshot Library Builder ' + VERSION,
    });
    files.push({ name: rel, content: out });
    // url is relative to library.json, so the file still works once the
    // folder is uploaded somewhere else.
    rows.push({
      folder: s.folder, filename: s.filename, url: encPath(rel),
      description, alt, elements: s.elements, module: s.module, screen: s.screen,
      page_title: s.page_title, source_path: s.source_path, captured: date,
    });
  }
  const library = {
    product: job.product, client: job.client,
    captured: date, image_size: job.size.width + 'x' + job.size.height, count: rows.length,
    images: rows, not_captured: job.not_captured.map((n) => ({ target: n.target, reason: n.reason })),
  };
  const libraryJson = Buffer.from(JSON.stringify(library, null, 2) + '\n', 'utf8');
  const readMe = Buffer.from([
    'Screenshot library: ' + job.product + (job.client ? ' (' + job.client + ')' : '') + ', ' + rows.length + ' screenshot' + (rows.length === 1 ? '' : 's') + ', captured ' + date + '.',
    '',
    'To keep these screenshots and use them in storyboards:',
    '',
    '1. Unzip this file. Keep the folders as they are. library.json lists every screenshot with its description.',
    '2. Upload everything to a folder anyone can open by link: a public GitHub repository, a public Amazon S3 or Google Cloud Storage bucket, or a public web folder. Google Drive, SharePoint and OneDrive cannot be used: storyboards and slide decks cannot open images from them by link.',
    '3. In the Storyboard Designer, paste the link into the Screenshot Library URL field: for GitHub, the link to the folder; for anywhere else, the link to library.json in it.',
    '',
  ].join('\r\n'), 'utf8');
  try {
    for (const f of files) fs.writeFileSync(path.join(dir, ...f.name.split('/')), f.content);
    fs.writeFileSync(path.join(dir, 'library.json'), libraryJson);
    fs.writeFileSync(path.join(dir, 'screenshots.zip'), zip.build([...files, { name: 'library.json', content: libraryJson }, { name: 'READ ME.txt', content: readMe }]));
  } catch (e) {
    console.error('[job ' + job.id + '] save failed: ' + String(e && e.message || e).split('\n')[0]);
    throw new CaptureError('The library could not be saved. Run the agent again.');
  }
  job.status = 'done';
  job.share = share;
  job.expires = Date.now() + RETENTION_MS;
  shares.set(share, job.id);
  job.library = {
    library_url: base + 'library.json',
    download_url: base + 'screenshots.zip',
    expires: new Date(job.expires).toISOString(),
    written: rows.length, descriptions_missing: missing,
  };
  job.library_rows = rows.map((r) => ({ ...r, url: base + r.url }));
  console.log('[job ' + job.id + '] library ready: ' + rows.length + ' image(s), kept ' + RETENTION_HOURS + ' hours');
  const md = [
    '**Library link:** ' + job.library.library_url,
    '',
    '**Download all screenshots:** [' + mdCell(job.product) + ' screenshots (zip)](' + job.library.download_url + ')',
    '',
    '**These links work until ' + whenUtc(job.expires) + '.** Make the storyboard and the slide deck before then. To keep the screenshots, download them: the READ ME inside says how to put them in your own folder.',
    '',
    '**Saved:** ' + rows.length + ' screenshot' + (rows.length === 1 ? '' : 's') + ', each ' + job.size.width + ' × ' + job.size.height,
    '',
    '| Screen | Description |',
    '|---|---|',
  ];
  job.library_rows.forEach((r, i) => md.push('| [' + mdCell(screenLabel(job.screens[i])) + '](' + r.url + ') | ' + mdCell(r.description) + ' |'));
  md.push('');
  if (missing) md.push('_' + missing + ' description' + (missing === 1 ? ' was' : 's were') + ' not written, so ' + (missing === 1 ? 'it uses' : 'they use') + ' the screen name._', '');
  const rep = reportMd(job);
  if (rep) md.push(rep);
  job.library.summary_md = md.join('\n');
  send(res, 200, { ...job.library, images: job.library_rows, not_captured: job.not_captured.map((n) => ({ target: n.target, reason: n.reason })) });
}

/** "28 Oct 2026, 14:05 UTC" */
function whenUtc(ms) {
  const d = new Date(ms);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return d.getUTCDate() + ' ' + mon + ' ' + d.getUTCFullYear() + ', ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' UTC';
}

const asciiName = (s) => String(s || '').replace(/[^\x20-\x7E]/g, '').replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim() || 'Screenshots';

/** GET /library/<token>/<path>: a library's files, until it expires. Only the files listed here are served. */
function serveLibrary(req, res, token, rel) {
  const id = shares.get(token);
  const job = id && jobs.get(id);
  if (!job || job.status !== 'done' || !job.expires || Date.now() > job.expires) {
    return send(res, 404, { error: 'This link has expired. Screenshot libraries are kept for ' + RETENTION_HOURS + ' hours. Run the Screenshot Library Builder again for new links.' });
  }
  const dir = path.join(WORK_DIR, job.id);
  let file, type, extra = {};
  if (rel === 'library.json') { file = path.join(dir, 'library.json'); type = 'application/json; charset=utf-8'; extra = { 'Access-Control-Allow-Origin': '*' }; }
  else if (rel === 'screenshots.zip') {
    file = path.join(dir, 'screenshots.zip'); type = 'application/zip';
    extra = { 'Content-Disposition': 'attachment; filename="' + asciiName(job.product + ' Screenshots') + '.zip"' };
  } else {
    const s = job.screens.find((x) => x.folder + '/' + x.filename === rel);
    if (s) { file = path.join(dir, s.folder, s.filename); type = 'image/png'; }
  }
  if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
  const buf = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=3600', ...SECURITY_HEADERS, ...extra });
  return res.end(req.method === 'HEAD' ? undefined : buf);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && p === '/health') {
      return send(res, 200, { status: 'ok', service: 'AaGeJa Capture Service', version: VERSION,
        running: !!running, queued: queue.length, key_set: !!CAPTURE_KEY, library_hours: RETENTION_HOURS });
    }

    const lib = p.match(/^\/library\/([a-f0-9]{32})\/(.+)$/);
    if (lib && (req.method === 'GET' || req.method === 'HEAD')) {
      let rel;
      try { rel = decodeURIComponent(lib[2]); } catch (_) { return send(res, 404, { error: 'Not found' }); }
      return serveLibrary(req, res, lib[1], rel);
    }

    if (p.startsWith('/capture/')) {
      if (!keyOk(req)) return send(res, 401, { error: 'Missing or wrong X-AaGeJa-Key' });

      let m = p.match(/^\/capture\/image\/([a-f0-9]{24})\/([^/]+)\/([^/]+\.png)$/);
      if (req.method === 'GET' && m) {
        const job = jobs.get(m[1]);
        const folder = decodeURIComponent(m[2]);
        const file = decodeURIComponent(m[3]);
        const isDebug = folder === '_debug' && job && /^debug-\d+\.png$/.test(file) &&
          (job.debug_image === file || job.not_captured.some((n) => n.debug_image === file));
        const s = job && (isDebug ? { folder, filename: file } : job.screens.find((x) => x.folder === folder && x.filename === file));
        const f = s && path.join(WORK_DIR, job.id, s.folder, s.filename);
        if (!f || !fs.existsSync(f)) return send(res, 404, { error: 'Image not found. Images are removed once the library is saved, and after 24 hours.' });
        const buf = fs.readFileSync(f);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
        return res.end(buf);
      }

      if (req.method === 'POST' && p === '/capture/start') return await start(req, res);
      m = p.match(/^\/capture\/(status|finalize)\/([a-f0-9]{24})$/);
      if (m) {
        const job = jobs.get(m[2]);
        if (!job) return send(res, 404, { error: 'No capture with that id. Captures are kept for 24 hours.' });
        if (req.method === 'GET' && m[1] === 'status') return send(res, 200, publicJob(job, req));
        if (req.method === 'POST' && m[1] === 'finalize') return await finalize(req, res, job);
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e instanceof CaptureError) return send(res, 400, { error: e.userMessage });
    console.error('[error]', String(e && e.message || e).split('\n')[0]);
    send(res, 500, { error: 'Something went wrong on the capture service. Try again; if it happens again, contact AaGeJa.' });
  }
});

server.listen(PORT, () => {
  console.log('AaGeJa Capture Service v' + VERSION + ' on port ' + PORT +
    (CAPTURE_KEY ? '' : ' — CAPTURE_KEY not set, keyed routes will refuse'));
});
