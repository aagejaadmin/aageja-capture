#!/usr/bin/env node
/**
 * AaGeJa Capture Service — v1.3.0 (October 2026)
 *
 * v1.3.0
 *   - The library folder is optional. Left blank, the library is kept here
 *     for 24 hours on links anyone can open (images, library.json and a zip of
 *     everything), the same 24 hours as other AaGeJa downloads. The links are
 *     unguessable and stop working after 24 hours.
 *   - A library can also be saved to a folder in the customer's Amazon S3
 *     bucket or Google Cloud Storage bucket, as well as GitHub. Before
 *     anything is captured the service writes one small file there
 *     (aageja-capture-check.txt) and opens it without signing in, so a folder
 *     it cannot write to, or that storyboards could not read, stops the run.
 *   - Google Drive, SharePoint, OneDrive, Dropbox and Box links are refused
 *     with a message saying why: storyboards and slide decks cannot open
 *     images from them by link.
 *   - For S3, Google Cloud Storage and the 24-hour folder, the library link is
 *     library.json, which the Storyboard Designer reads with each screen's
 *     description. For GitHub it is the folder, as before.
 *   - GET /accounts names the capture service's own GitHub account, AWS user
 *     and Google service account, so the intake can tell people exactly
 *     which account to give access to. No key; it returns names only.
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
 *   GET  /accounts                        The accounts customers give access to
 *   POST /capture/start                   Start a job              (key)
 *   GET  /capture/status/:id              Progress and results     (key)
 *   GET  /capture/image/:id/:folder/:file A captured image, for preview (key)
 *   POST /capture/finalize/:id            Descriptions in -> metadata,
 *                                         library.json, saved      (key)
 *   GET  /library/:token/...              A 24-hour library: library.json,
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
 *   GITHUB_TOKEN         The capture service's own GitHub account: a classic
 *                        token with the public_repo scope. Customers add that
 *                        account to their repository with write access.
 *   AWS_ACCESS_KEY_ID,   The capture service's own AWS user. Customers let it
 *   AWS_SECRET_ACCESS_KEY  add files to their bucket folder.
 *   GCS_SA_KEY           The capture service's own Google service account: its
 *                        JSON key, the whole file. Customers give it the
 *                        Storage Object User role on their bucket.
 *   Each of the three is optional; a kind of folder with no account set is
 *   refused with a message.
 *   RETENTION_HOURS      Hours a job, its images and a 24-hour library are
 *                        kept (default 24).
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
const { runCapture, parseTargets, parseSize, isPrivateIp, isInternalName, ALLOW_LOCAL, CaptureError } = require('./capture');
const png = require('./png-meta');
const github = require('./storage-github');
const s3 = require('./storage-s3');
const gcs = require('./storage-gcs');
const zip = require('./zip');

const VERSION = '1.3.0';
const PORT = process.env.PORT || 3000;
const CAPTURE_KEY = process.env.CAPTURE_KEY || '';
const WORK_DIR = process.env.WORK_DIR || '/tmp/capture';
const RETENTION_HOURS = Number(process.env.RETENTION_HOURS) || 24;
const RETENTION_MS = RETENTION_HOURS * 3600 * 1000;

fs.mkdirSync(WORK_DIR, { recursive: true });

const jobs = new Map();
const shares = new Map();   // 24-hour library token -> job id
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
  return Array.isArray(x) ? x : [];
}

const mdCell = (t) => String(t || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/** "Admin > Users", or just "Home" when module and screen are the same. */
const screenLabel = (s) => (s.module && s.screen && s.module.toLowerCase() !== s.screen.toLowerCase() ? s.module + ' > ' + s.screen : (s.screen || s.target));

/** Each screen's page text, for the AI step that writes descriptions. */
function aiInput(job) {
  return job.screens.map((s, i) => [
    (i + 1) + '. filename: ' + s.filename,
    '   screen: ' + screenLabel(s),
    '   page title: ' + (s.page_title || ''),
    '   headings: ' + (s.headings || []).join(' | '),
    '   labels: ' + (s.labels || []).slice(0, 20).join(' | '),
    '   controls: ' + (s.elements || []).slice(0, 25).join(' | '),
  ].join('\n')).join('\n\n');
}

/** What was not captured and what to check, as Markdown. Empty when there is nothing to report. */
function reportMd(job) {
  const out = [];
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
    out.push('**Requests the pages made while loading**', '',
      'The capture only opened pages and menu items. While they loaded, the pages themselves sent ' +
      job.background_requests + ' request' + (job.background_requests === 1 ? '' : 's') +
      ' that were not plain reads, as they do for anyone viewing them:', '');
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
    library_folder: job.storage ? storageLabel(job.storage) : '',
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
  console.log('[job ' + job.id + '] started: ' + job.targets.length + ' target(s)');
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

/** A job ends RETENTION_HOURS after it finished; a 24-hour library, that long after it was saved. */
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

const FOLDER_EXAMPLE = 'https://github.com/your-organization/screenshots/tree/main/product-name';

/**
 * The library folder: a github.com link to a folder (or a whole repository)
 * that the person copies from their browser. Returns { repo, branch, folder };
 * branch is '' when the link names none (the repository's default is used).
 */
function parseFolderLink(link) {
  const bad = () => new CaptureError('The library folder must be a GitHub folder link, for example ' + FOLDER_EXAMPLE);
  let u;
  try { u = new URL(String(link || '').trim()); } catch (_) { throw bad(); }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com') throw bad();
  let parts;
  try { parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch (_) { throw bad(); }
  if (parts.length < 2) throw bad();
  const repo = parts[0] + '/' + parts[1].replace(/\.git$/i, '');
  let branch = '', folder = '';
  if (parts.length > 2) {
    if (parts[2] !== 'tree' || parts.length < 4) {
      throw new CaptureError('Open the folder on GitHub and copy the address from your browser. It looks like ' + FOLDER_EXAMPLE);
    }
    branch = parts[3];
    folder = parts.slice(4).join('/');
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw bad();
  if (folder && (!/^[A-Za-z0-9._\/-]+$/.test(folder) || folder.split('/').includes('..'))) {
    throw new CaptureError('Folder names in the library folder may use letters, numbers, dots, hyphens and underscores only.');
  }
  return { repo, branch, folder };
}

const ANY_FOLDER = 'Paste a GitHub, Amazon S3 or Google Cloud Storage folder link, or leave the Library Folder blank to get links that work for 24 hours.';

/** Folder links the capture service cannot use, with the reason in plain words. */
function refusedFolder(u) {
  const h = u.hostname.toLowerCase();
  const why = ' folders cannot be used: storyboards and slide decks cannot open images from them by link. ' + ANY_FOLDER;
  if (/(^|\.)(drive|docs)\.google\.com$/.test(h)) return 'Google Drive' + why;
  if (/(^|\.)sharepoint\.com$/.test(h) || /(^|\.)onedrive\.(live|com)\b/.test(h) || h === '1drv.ms') return 'SharePoint and OneDrive' + why;
  if (/(^|\.)dropbox\.com$/.test(h) || /(^|\.)box\.com$/.test(h)) return 'Dropbox and Box' + why;
  return '';
}

/**
 * Where a job's library goes, checked before anything is captured:
 *   blank                       { type: 'aageja' }  kept here for 24 hours
 *   github.com folder           { type: 'github', repo, branch, folder }
 *   S3 folder (s3://, https://) { type: 's3', bucket, prefix, region }
 *   Google Cloud Storage folder { type: 'gcs', bucket, prefix }
 */
async function checkStorage(link) {
  const raw = String(link || '').trim();
  if (!raw) return { type: 'aageja' };
  let u;
  try { u = new URL(raw); } catch (_) { throw new CaptureError('The library folder is not a link. ' + ANY_FOLDER); }
  const refused = refusedFolder(u);
  if (refused) throw new CaptureError(refused);
  const asCapture = (e) => (e && e.userMessage ? new CaptureError(e.userMessage) : e);
  if (u.hostname.toLowerCase() === 'github.com') {
    const { repo, branch, folder } = parseFolderLink(raw);
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new CaptureError('Saving to GitHub is not set up on the capture service yet. Leave the Library Folder blank, or contact AaGeJa.');
    let b;
    try { b = await github.checkTarget({ token, repo, branch }); } catch (e) { throw asCapture(e); }
    return { type: 'github', repo, branch: b, folder };
  }
  if (s3.isS3Link(raw)) {
    try { return { type: 's3', ...(await s3.checkTarget(raw)) }; } catch (e) { throw asCapture(e); }
  }
  if (gcs.isGcsLink(raw)) {
    try { return { type: 'gcs', ...(await gcs.checkTarget(raw)) }; } catch (e) { throw asCapture(e); }
  }
  throw new CaptureError('The capture service cannot save to this link. ' + ANY_FOLDER);
}

const inPrefix = (prefix, p) => (prefix ? prefix + '/' : '') + p;
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** Where the library is, in words a person recognises. */
function storageLabel(st) {
  if (st.type === 'github') return github.treeUrl(st.repo, st.branch, st.folder);
  if (st.type === 's3') return 's3://' + st.bucket + '/' + (st.prefix ? st.prefix + '/' : '');
  if (st.type === 'gcs') return 'gs://' + st.bucket + '/' + (st.prefix ? st.prefix + '/' : '');
  return 'AaGeJa, for ' + RETENTION_HOURS + ' hours';
}

/**
 * One interface over the four places a library can go. Paths are inside the
 * library folder: "<folder>/<file>.png" and "library.json".
 *   url(st, path)      the link anyone can open
 *   read(st)           library.json already there, or null
 *   write(st, files)   save every file; returns a reference for the log
 *   link(st)           the library link for the Storyboard Designer
 */
const backends = {
  github: {
    url: (st, p) => github.rawUrl(st.repo, st.branch, inPrefix(st.folder, p)),
    read: (st) => github.readLibrary({ token: process.env.GITHUB_TOKEN, repo: st.repo, branch: st.branch, folder: st.folder }),
    async write(st, files, job, rows) {
      const msg = 'Screenshot library: ' + job.product + (job.client ? ' (' + job.client + ')' : '') + ', ' + rows.length + ' screen(s), ' + today();
      const { commit } = await github.commitFiles({ token: process.env.GITHUB_TOKEN, repo: st.repo, branch: st.branch,
        files: files.map((f) => ({ path: inPrefix(st.folder, f.path), content: f.content })), message: msg });
      return commit.slice(0, 7);
    },
    link: (st) => github.treeUrl(st.repo, st.branch, st.folder),
    saveError: (e, st) => github.saveError(e, st.repo),
  },
  s3: {
    url: (st, p) => s3.publicUrl(st, inPrefix(st.prefix, p)),
    read: (st) => s3.readLibrary(st),
    async write(st, files) { await s3.writeFiles(st, files); return files.length + ' file(s)'; },
    link: (st) => s3.publicUrl(st, inPrefix(st.prefix, 'library.json')),
    saveError: (e, st) => s3.saveError(e, st),
  },
  gcs: {
    url: (st, p) => gcs.publicUrl(st, inPrefix(st.prefix, p)),
    read: (st) => gcs.readLibrary(st),
    async write(st, files) { await gcs.writeFiles(st, files); return files.length + ' file(s)'; },
    link: (st) => gcs.publicUrl(st, inPrefix(st.prefix, 'library.json')),
    saveError: (e, st) => gcs.saveError(e, st),
  },
  aageja: {
    url: (st, p) => st.base + '/library/' + st.share + '/' + encPath(p),
    read: async () => null,
    async write(st, files, job) {
      const dir = path.join(WORK_DIR, job.id);
      for (const f of files) {
        const out = path.join(dir, ...f.path.split('/'));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, f.content);
      }
      fs.writeFileSync(path.join(dir, 'screenshots.zip'), zip.build(files.map((f) => ({ name: f.path, content: f.content }))));
      return 'kept for ' + RETENTION_HOURS + ' hours';
    },
    link: (st) => st.base + '/library/' + st.share + '/library.json',
    saveError: () => 'The library could not be written on the capture service. Try again in a moment.',
  },
};

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
  if (!username.trim() || !password) throw new CaptureError('Enter the username and the password for the environment.');
  const env = await checkEnvironment(body.environment_url);
  const storage = await checkStorage(body.library_folder);
  const mode = String(body.mode || 'guided').toLowerCase();
  if (mode !== 'guided') throw new CaptureError('This version captures a list of pages (Guided). Full crawl and Refresh are not available yet.');

  const targets = parseTargets(body.targets, env.href);
  const size = parseSize(body.image_size);
  const maskWords = (Array.isArray(body.mask_words) ? body.mask_words : String(body.mask_words || '').split(/[\n,]/))
    .map((s) => String(s).trim()).filter((s) => s.length >= 2).slice(0, 50);

  const id = crypto.randomBytes(12).toString('hex');
  const job = {
    id, status: 'queued', stage: '', created: Date.now(),
    product, client, environment_url: env.href, size, mask_words: maskWords, targets,
    progress: { done: 0, total: targets.length, current: '' },
    screens: [], not_captured: [], masked: 0, blocked_requests: 0, blocked: [], trace: [], debug_image: '',
    background_requests: 0, background: [],
    storage,
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
  // Saving twice returns the first save: the images are gone once saved.
  if (job.status === 'done' && job.library) return send(res, 200, { ...job.library, images: job.library_rows || [], not_captured: job.not_captured.map((n) => ({ target: n.target, reason: n.reason })) });
  if (job.status !== 'captured') {
    throw new CaptureError(job.status === 'failed' ? 'This capture failed, so there is nothing to save.' : 'This capture is still running. Check its status first.');
  }
  // The body is the AI step's output as plain text (from the agent), or
  // { descriptions }. The library folder is the one checked at start.
  const raw = await readBody(req, 1024 * 1024);
  let body = null;
  try { body = JSON.parse(raw); } catch (_) { body = null; }
  const wrapped = body && typeof body === 'object' && !Array.isArray(body) && 'descriptions' in body;
  const st = job.storage;
  const be = backends[st.type];
  if (st.type === 'aageja') {
    st.base = baseUrl(req);
    st.share = crypto.randomBytes(16).toString('hex');
  }

  const descs = parseDescriptions(wrapped ? body.descriptions : raw);
  const byName = new Map(descs.filter((d) => d && d.filename).map((d) => [String(d.filename).trim(), d]));
  const date = today();
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
    const src = fs.readFileSync(path.join(WORK_DIR, job.id, s.folder, s.filename));
    const out = png.embed(src, {
      Title: s.screen, Description: description, Alt: alt, Screen: s.module + ' > ' + s.screen,
      Source: s.source_path, Captured: date, Elements: s.elements.join('; '),
      Software: 'AaGeJa Screenshot Library Builder ' + VERSION,
    });
    files.push({ path: rel, content: out, type: 'image/png' });
    rows.push({
      folder: s.folder, filename: s.filename, url: be.url(st, rel),
      description, alt, elements: s.elements, module: s.module, screen: s.screen,
      page_title: s.page_title, source_path: s.source_path, captured: date,
    });
  }

  let ref, images;
  try {
    // Merge with a library already in the folder: same file replaces its row,
    // every other row is kept. Nothing is deleted.
    const existing = await be.read(st);
    const keep = existing && Array.isArray(existing.images)
      ? existing.images.filter((r) => !rows.some((x) => x.folder === r.folder && x.filename === r.filename)) : [];
    images = keep.concat(rows).sort((a, b) => String(a.folder).localeCompare(String(b.folder)) || String(a.filename).localeCompare(String(b.filename)));
    const library = {
      product: job.product, client: job.client,
      captured: date, image_size: job.size.width + 'x' + job.size.height, count: images.length,
      images, not_captured: job.not_captured.map((n) => ({ target: n.target, reason: n.reason })),
    };
    // library.json goes last, so it never lists an image that was not saved.
    files.push({ path: 'library.json', content: Buffer.from(JSON.stringify(library, null, 2) + '\n', 'utf8'), type: 'application/json; charset=utf-8' });
    ref = await be.write(st, files, job, rows);
  } catch (e) {
    console.error('[job ' + job.id + '] save failed: ' + String(e && e.message || e).split('\n')[0]);
    throw new CaptureError('The library was not saved: ' + be.saveError(e, st));
  }
  job.status = 'done';
  const temporary = st.type === 'aageja';
  if (temporary) {
    job.expires = Date.now() + RETENTION_MS;
    shares.set(st.share, job.id);
  }
  job.library = {
    library_url: be.link(st),
    library_json_url: be.url(st, 'library.json'),
    saved_to: storageLabel(st),
    ...(temporary ? { download_url: st.base + '/library/' + st.share + '/screenshots.zip', expires: new Date(job.expires).toISOString() } : {}),
    written: rows.length, total_in_library: images.length, descriptions_missing: missing,
  };
  job.library_rows = rows;
  console.log('[job ' + job.id + '] saved ' + rows.length + ' image(s) to ' + st.type + ' (' + ref + ')');

  const md = ['**Library link:** ' + job.library.library_url, ''];
  if (temporary) {
    md.push('**Download all screenshots:** [' + mdCell(job.product) + ' screenshots (zip)](' + job.library.download_url + ')', '',
      '**These links work until ' + whenUtc(job.expires) + '.** Make the storyboard and the slide deck before then, and download the screenshots to keep them.', '');
  } else if (job.library.saved_to !== job.library.library_url) {
    md.push('**Saved to:** ' + job.library.saved_to, '');
  }
  md.push('**Saved:** ' + rows.length + ' screenshot' + (rows.length === 1 ? '' : 's') +
      (images.length > rows.length ? ' (' + images.length + ' in the library in total)' : '') +
      ', each ' + job.size.width + ' × ' + job.size.height, '',
    '| Screen | Description |',
    '|---|---|');
  rows.forEach((r, i) => md.push('| [' + mdCell(screenLabel(job.screens[i])) + '](' + r.url + ') | ' + mdCell(r.description) + ' |'));
  md.push('');
  if (missing) md.push('_' + missing + ' description' + (missing === 1 ? ' was' : 's were') + ' not written, so ' + (missing === 1 ? 'it uses' : 'they use') + ' the screen name._', '');
  const rep = reportMd(job);
  if (rep) md.push(rep);
  job.library.summary_md = md.join('\n');
  // Saved elsewhere: this service keeps none of the images. A 24-hour
  // library keeps them here until it expires.
  if (!temporary) fs.rmSync(path.join(WORK_DIR, job.id), { recursive: true, force: true });
  send(res, 200, { ...job.library, images: rows, not_captured: job.not_captured.map((n) => ({ target: n.target, reason: n.reason })) });
}

/** "28 Oct 2026, 14:05 UTC" */
function whenUtc(ms) {
  const d = new Date(ms);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return d.getUTCDate() + ' ' + mon + ' ' + d.getUTCFullYear() + ', ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' UTC';
}

const asciiName = (s) => String(s || '').replace(/[^\x20-\x7E]/g, '').replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim() || 'Screenshots';

/** GET /library/<token>/<path>: a 24-hour library's files, while it lasts. */
function serveLibrary(req, res, token, rel) {
  const id = shares.get(token);
  const job = id && jobs.get(id);
  if (!job || job.status !== 'done' || !job.expires || Date.now() > job.expires) {
    return send(res, 404, { error: 'This link has expired. Libraries kept by AaGeJa last ' + RETENTION_HOURS + ' hours. Run the Screenshot Library Builder again for new links.' });
  }
  const dir = path.join(WORK_DIR, job.id);
  let file, type, extra = {};
  if (rel === 'library.json') { file = path.join(dir, 'library.json'); type = 'application/json; charset=utf-8'; extra = { 'Access-Control-Allow-Origin': '*' }; }
  else if (rel === 'screenshots.zip') {
    file = path.join(dir, 'screenshots.zip'); type = 'application/zip';
    extra = { 'Content-Disposition': 'attachment; filename="' + asciiName(job.product + ' Screenshots') + '.zip"' };
  } else {
    const row = (job.library_rows || []).find((r) => r.folder + '/' + r.filename === rel);
    if (row) { file = path.join(dir, row.folder, row.filename); type = 'image/png'; }
  }
  if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
  const buf = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=3600', ...SECURITY_HEADERS, ...extra });
  return res.end(req.method === 'HEAD' ? undefined : buf);
}

let accountsCache = null;
/** The capture service's own accounts, which customers give access to. Names only. */
async function accounts() {
  if (accountsCache && accountsCache.at > Date.now() - 10 * 60 * 1000) return accountsCache.value;
  const value = {
    github: process.env.GITHUB_TOKEN ? (await github.accountName(process.env.GITHUB_TOKEN)) || null : null,
    aws: s3.configured() ? (await s3.accountName()) || null : null,
    google: gcs.configured() ? (await gcs.accountName()) || null : null,
    temporary_hours: RETENTION_HOURS,
  };
  accountsCache = { at: Date.now(), value };
  return value;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && p === '/health') {
      return send(res, 200, { status: 'ok', service: 'AaGeJa Capture Service', version: VERSION,
        running: !!running, queued: queue.length, key_set: !!CAPTURE_KEY,
        github: !!process.env.GITHUB_TOKEN, s3: s3.configured(), gcs: gcs.configured() });
    }

    if (req.method === 'GET' && p === '/accounts') {
      const body = await accounts();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...SECURITY_HEADERS });
      return res.end(JSON.stringify(body));
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
