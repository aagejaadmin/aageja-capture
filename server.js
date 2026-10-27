#!/usr/bin/env node
/**
 * AaGeJa Capture Service — v1.0.3 (October 2026)
 *
 * v1.0.3
 *   - A safe step whose normal click times out (something on the page sits
 *     over it) is clicked directly instead. Found on Cornerstone's menu button.
 *
 * v1.0.2
 *   - A menu step that is not visible opens the site's collapsed menu
 *     controls (for example the three-line button) one at a time and looks
 *     again, so "Admin > Users" works on sites that hide their menu.
 *   - The page reached after sign-in is named "home"; a page title such as
 *     "Welcome - Site Name" names the screen by its first part; long names are
 *     cut at a word boundary.
 *
 * v1.0.1 — first run against a real site (Cornerstone training environment)
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
 *   GET  /capture/image/:id/:folder/:file A captured image, for preview
 *   POST /capture/finalize/:id            Descriptions in -> metadata,
 *                                         library.json, one commit (key)
 *
 * Start a job, then check back: a capture outlives any single HTTP request.
 * One job runs at a time; others wait in order.
 *
 * Credentials. The username and password go into the browser and nowhere
 * else. They are not written to disk, not logged, not returned by any route,
 * and dropped when the job's browser closes.
 *
 * Environment variables:
 *   CAPTURE_KEY      Required. Callers send it as X-AaGeJa-Key. Unset means
 *                    every keyed route refuses.
 *   GITHUB_TOKEN     AaGeJa's own token, for libraries written to AaGeJa repos.
 *   HOUSE_REPOS      Comma-separated repos GITHUB_TOKEN may write to
 *                    (default aagejaadmin/aageja-screenshots).
 *   RETENTION_HOURS  Hours a job and its images are kept (default 24).
 *   WORK_DIR         Where images wait between capture and finalize
 *                    (default /tmp/capture).
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runCapture, parseTargets, parseSize, CaptureError } = require('./capture');
const png = require('./png-meta');
const github = require('./storage-github');

const VERSION = '1.0.3';
const PORT = process.env.PORT || 3000;
const CAPTURE_KEY = process.env.CAPTURE_KEY || '';
const WORK_DIR = process.env.WORK_DIR || '/tmp/capture';
const RETENTION_MS = (Number(process.env.RETENTION_HOURS) || 24) * 3600 * 1000;
const HOUSE_REPOS = new Set((process.env.HOUSE_REPOS || 'aagejaadmin/aageja-screenshots')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

fs.mkdirSync(WORK_DIR, { recursive: true });

const jobs = new Map();
const queue = [];
let running = null;

// ── Helpers ────────────────────────────────────────────────────────────────

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
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

/** Accepts an array, { images: [...] }, or the same as a JSON string (with or without code fences). */
function parseDescriptions(v) {
  let x = v;
  if (typeof x === 'string') {
    const s = x.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    if (!s) return [];
    try { x = JSON.parse(s); } catch (_) { throw new CaptureError('Descriptions are not valid JSON'); }
  }
  if (x && !Array.isArray(x)) x = x.images || x.screens || x.descriptions || [];
  return Array.isArray(x) ? x : [];
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
    screens: job.screens.map((s) => ({
      ...s,
      preview_url: b + '/capture/image/' + job.id + '/' + encodeURIComponent(s.folder) + '/' + encodeURIComponent(s.filename),
    })),
    not_captured: job.not_captured.map((n) => ({ ...n, ...(n.debug_image ? { debug_preview_url: b + '/capture/image/' + job.id + '/_debug/' + n.debug_image } : {}) })),
    error: job.error || null,
    debug_preview_url: job.debug_image ? b + '/capture/image/' + job.id + '/_debug/' + job.debug_image : null,
    trace: job.trace,
    blocked: job.blocked,
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

function purge() {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, job] of jobs) {
    if (job === running || job.status === 'queued') continue;
    if ((job.finished || job.created) < cutoff) {
      fs.rmSync(path.join(WORK_DIR, id), { recursive: true, force: true });
      jobs.delete(id);
    }
  }
  for (const name of fs.readdirSync(WORK_DIR)) if (!jobs.has(name)) {
    const p = path.join(WORK_DIR, name);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
  }
}
setInterval(purge, 3600 * 1000).unref();

// ── Routes ─────────────────────────────────────────────────────────────────

async function start(req, res) {
  const body = parseJson(await readBody(req, 64 * 1024));
  const product = String(body.product || body.product_name || '').trim();
  const client = String(body.client || body.client_name || '').trim();
  const environmentUrl = String(body.environment_url || '').trim();
  if (!product) throw new CaptureError('Product name is required');
  let env;
  try { env = new URL(environmentUrl); } catch (_) { throw new CaptureError('Environment address must be a full web address starting with https://'); }
  if (env.protocol !== 'https:' && env.protocol !== 'http:') throw new CaptureError('Environment address must start with https://');
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
    _creds: { username: String(body.username || ''), password: String(body.password || '') },
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
  if (job.status !== 'captured' && job.status !== 'done') {
    throw new CaptureError(job.status === 'failed' ? 'This capture failed, so there is nothing to save.' : 'This capture is still running. Check its status first.');
  }
  const body = parseJson(await readBody(req, 1024 * 1024));
  const storage = body.storage || {};
  const type = String(storage.type || 'github').toLowerCase();
  if (type !== 'github') throw new CaptureError('This version saves to GitHub only.');
  const repo = String(storage.repo || '').trim();
  const branch = String(storage.branch || 'main').trim();
  const folder = String(storage.folder || '').trim().replace(/^\/+|\/+$/g, '');
  if (!folder || !/^[A-Za-z0-9._\/-]+$/.test(folder) || folder.includes('..')) {
    throw new CaptureError('Library folder must be letters, numbers, hyphens and slashes, for example cornerstone/training-env');
  }
  if (!HOUSE_REPOS.has(repo.toLowerCase())) throw new CaptureError('This version can only save to ' + [...HOUSE_REPOS].join(', '));
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new CaptureError('GitHub is not connected on the capture service.');

  const descs = parseDescriptions(body.descriptions);
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
    const filePath = folder + '/' + s.folder + '/' + s.filename;
    const src = fs.readFileSync(path.join(WORK_DIR, job.id, s.folder, s.filename));
    const out = png.embed(src, {
      Title: s.screen, Description: description, Alt: alt, Screen: s.module + ' > ' + s.screen,
      Source: s.source_url, Captured: date, Elements: s.elements.join('; '),
      Environment: job.environment_url, Software: 'AaGeJa Screenshot Library Builder ' + VERSION,
    });
    files.push({ path: filePath, content: out });
    rows.push({
      folder: s.folder, filename: s.filename, url: github.rawUrl(repo, branch, filePath),
      description, alt, elements: s.elements, module: s.module, screen: s.screen,
      page_title: s.page_title, source_url: s.source_url, captured: date,
    });
  }

  // Merge with a library already in the folder: same file replaces its row,
  // every other row is kept. Nothing is deleted.
  const existing = await github.readLibrary({ token, repo, branch, folder });
  const keep = existing && Array.isArray(existing.images)
    ? existing.images.filter((r) => !rows.some((x) => x.folder === r.folder && x.filename === r.filename)) : [];
  const images = keep.concat(rows).sort((a, b) => a.folder.localeCompare(b.folder) || a.filename.localeCompare(b.filename));
  const library = {
    product: job.product, client: job.client, environment_url: job.environment_url,
    captured: date, image_size: job.size.width + 'x' + job.size.height, count: images.length,
    images, not_captured: job.not_captured.map((n) => ({ target: n.target, reason: n.reason })),
  };
  files.push({ path: folder + '/library.json', content: Buffer.from(JSON.stringify(library, null, 2) + '\n', 'utf8') });

  const msg = 'Screenshot library: ' + job.product + (job.client ? ' (' + job.client + ')' : '') + ', ' + rows.length + ' screen(s), ' + date;
  const { commit } = await github.commitFiles({ token, repo, branch, files, message: msg });
  job.status = 'done';
  job.library = {
    library_url: github.treeUrl(repo, branch, folder),
    library_json_url: github.rawUrl(repo, branch, folder + '/library.json'),
    commit, written: rows.length, total_in_library: images.length, descriptions_missing: missing,
  };
  console.log('[job ' + job.id + '] saved ' + rows.length + ' image(s) to ' + repo + '@' + branch + ' (' + commit.slice(0, 7) + ')');
  send(res, 200, { ...job.library, images: rows, not_captured: library.not_captured });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && p === '/health') {
      return send(res, 200, { status: 'ok', service: 'AaGeJa Capture Service', version: VERSION,
        running: !!running, queued: queue.length, key_set: !!CAPTURE_KEY, github: !!process.env.GITHUB_TOKEN });
    }

    let m = p.match(/^\/capture\/image\/([a-f0-9]{24})\/([^/]+)\/([^/]+\.png)$/);
    if (req.method === 'GET' && m) {
      const job = jobs.get(m[1]);
      const folder = decodeURIComponent(m[2]);
      const file = decodeURIComponent(m[3]);
      const isDebug = folder === '_debug' && job && /^debug-\d+\.png$/.test(file) &&
        (job.debug_image === file || job.not_captured.some((n) => n.debug_image === file));
      const s = job && (isDebug ? { folder, filename: file } : job.screens.find((x) => x.folder === folder && x.filename === file));
      if (!s) return send(res, 404, { error: 'Image not found or expired' });
      const buf = fs.readFileSync(path.join(WORK_DIR, job.id, s.folder, s.filename));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=3600' });
      return res.end(buf);
    }

    if (p.startsWith('/capture/')) {
      if (!keyOk(req)) return send(res, 401, { error: 'Missing or wrong X-AaGeJa-Key' });
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
    send(res, 500, { error: String(e && e.message || e).split('\n')[0].slice(0, 300) });
  }
});

server.listen(PORT, () => {
  console.log('AaGeJa Capture Service v' + VERSION + ' on port ' + PORT +
    (CAPTURE_KEY ? '' : ' — CAPTURE_KEY not set, keyed routes will refuse'));
});
