'use strict';
/**
 * Saves a screenshot library to a folder in the customer's Google Cloud
 * Storage bucket.
 *
 * The customer gives a folder link and, once, gives the capture service's
 * Google service account the Storage Object User role on the bucket (add and
 * replace files), and gives allUsers the Storage Object Viewer role, because
 * storyboards and slide decks open the images by link.
 *
 * check() proves both before anything is captured: it asks Google which of the
 * two permissions the account has, writes one small file,
 * aageja-capture-check.txt, into the folder (the same name every run), then
 * opens it without signing in.
 *
 * Nothing is deleted. A file with the same name is replaced; every other file
 * in the folder is left as it was. (Google counts replacing a file as
 * deleting the old one, so the account needs that permission; this code
 * never deletes anything.)
 *
 * Environment:
 *   GCS_SA_KEY    The capture service account's JSON key, the whole file.
 *   GCS_API_BASE  Test machine only: a stand-in for storage.googleapis.com.
 */

const crypto = require('node:crypto');

const API = (process.env.GCS_API_BASE || 'https://storage.googleapis.com').replace(/\/+$/, '');
const PROBE = 'aageja-capture-check.txt';
const EXAMPLE = 'gs://your-bucket/screenshots/product-name/';
const NEEDED = ['storage.objects.create', 'storage.objects.delete'];

function userError(message) { const e = new Error(message); e.userMessage = message; return e; }

let key = null;
function saKey() {
  if (key) return key;
  const raw = process.env.GCS_SA_KEY;
  if (!raw) return null;
  try { key = JSON.parse(raw); } catch (_) { console.error('[gcs] GCS_SA_KEY is not valid JSON'); return null; }
  if (!key.client_email || !key.private_key) { console.error('[gcs] GCS_SA_KEY has no client_email or private_key'); key = null; }
  return key;
}
const configured = () => !!saKey();
const accountName = async () => (saKey() ? saKey().client_email : '');

const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

function isGcsLink(link) {
  let u;
  try { u = new URL(String(link || '').trim()); } catch (_) { return false; }
  const h = u.hostname.toLowerCase();
  return u.protocol === 'gs:' || h === 'storage.googleapis.com' || h === 'storage.cloud.google.com' || h.endsWith('.storage.googleapis.com') ||
    (h === 'console.cloud.google.com' && u.pathname.startsWith('/storage/'));
}

/**
 * Accepted forms:
 *   gs://bucket/folder/                                        (Copy gsutil URI)
 *   https://storage.googleapis.com/bucket/folder/              (public URL)
 *   https://storage.cloud.google.com/bucket/folder/            (authenticated URL)
 *   https://console.cloud.google.com/storage/browser/bucket/folder
 * Returns { bucket, prefix }.
 */
function parseLink(link) {
  const bad = () => userError('This is not a Google Cloud Storage folder link. In the Cloud console, open the folder and copy its gsutil URI. It looks like ' + EXAMPLE);
  let u;
  try { u = new URL(String(link || '').trim()); } catch (_) { throw bad(); }
  const h = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch (_) { return s; } });
  let bucket = '', prefix = '';
  if (u.protocol === 'gs:') {
    bucket = h; prefix = segs.join('/');
  } else if (h === 'storage.googleapis.com' || h === 'storage.cloud.google.com') {
    bucket = segs.shift() || ''; prefix = segs.join('/');
  } else if (h.endsWith('.storage.googleapis.com')) {
    bucket = h.slice(0, -'.storage.googleapis.com'.length); prefix = segs.join('/');
  } else if (h === 'console.cloud.google.com') {
    // /storage/browser/<bucket>/<folder...>, sometimes with ;tab=objects on a segment
    const p = segs.map((s) => s.split(';')[0]).filter(Boolean);
    let i = p.indexOf('browser');
    if (i < 0) throw bad();
    if (p[i + 1] === '_details') i++;
    bucket = p[i + 1] || ''; prefix = p.slice(i + 2).join('/');
    const q = u.searchParams.get('prefix');
    if (q) prefix = q;
  } else throw bad();
  bucket = bucket.toLowerCase();
  if (!BUCKET_RE.test(bucket)) throw bad();
  prefix = prefix.replace(/^\/+|\/+$/g, '');
  // A link to one file in the folder (an image or library.json) means its folder.
  if (/\.(png|jpe?g|gif|webp|json|txt)$/i.test(prefix)) prefix = prefix.split('/').slice(0, -1).join('/');
  if (prefix && (!/^[A-Za-z0-9._\/ -]+$/.test(prefix) || prefix.split('/').some((x) => x === '..' || !x.trim()))) {
    throw userError('Folder names in the library folder may use letters, numbers, spaces, dots, hyphens and underscores only.');
  }
  return { bucket, prefix };
}

const encKey = (k) => k.split('/').map(encodeURIComponent).join('/');
const publicUrl = (t, k) => API + '/' + t.bucket + '/' + encKey(k);

// ── Access token: the service account signs a JWT and trades it for a token.
let token = null;
async function accessToken() {
  if (token && token.expires > Date.now() + 60000) return token.value;
  const k = saKey();
  const now = Math.floor(Date.now() / 1000);
  const aud = k.token_uri || 'https://oauth2.googleapis.com/token';
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: k.client_email, scope: 'https://www.googleapis.com/auth/devstorage.read_write', aud, iat: now, exp: now + 3600,
  });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(k.private_key).toString('base64url');
  const r = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw Object.assign(new Error('Google token request returned ' + r.status + ': ' + (j.error_description || j.error || '')), { status: 401 });
  token = { value: j.access_token, expires: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return token.value;
}

async function gcs(method, route, body, headers) {
  const r = await fetch(API + route, {
    method,
    headers: { Authorization: 'Bearer ' + await accessToken(), ...(headers || {}) },
    body,
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  if (!r.ok) {
    throw Object.assign(new Error('Google Cloud Storage ' + method + ' ' + route.split('?')[0] + ' returned ' + r.status + ': ' +
      ((json && json.error && json.error.message) || text.slice(0, 200))), { status: r.status });
  }
  return json;
}

/** Adds or replaces one file. */
async function upload(t, name, content, type) {
  const boundary = 'aageja' + crypto.randomBytes(12).toString('hex');
  const meta = JSON.stringify({ name, contentType: type, cacheControl: 'no-cache' });
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n--' + boundary + '\r\nContent-Type: ' + type + '\r\n\r\n'),
    Buffer.isBuffer(content) ? content : Buffer.from(String(content)),
    Buffer.from('\r\n--' + boundary + '--\r\n'),
  ]);
  return gcs('POST', '/upload/storage/v1/b/' + encodeURIComponent(t.bucket) + '/o?uploadType=multipart', body,
    { 'Content-Type': 'multipart/related; boundary=' + boundary });
}

/**
 * Confirms the library can be saved here and opened by link. Throws Error
 * with a userMessage the person running the agent can act on.
 */
async function checkTarget(link) {
  if (!configured()) throw userError('Saving to Google Cloud Storage is not set up on the capture service yet. Leave the Library Folder blank, or contact AaGeJa.');
  const t = parseLink(link);
  const who = await accountName();
  const folder = 'gs://' + t.bucket + '/' + (t.prefix ? t.prefix + '/' : '');
  const noAccess = 'The capture service cannot add files to ' + folder + '. Ask your Google Cloud administrator to give ' + who +
    ' the Storage Object User role on the bucket ' + t.bucket + '.';
  let granted;
  try {
    const q = NEEDED.map((p) => 'permissions=' + encodeURIComponent(p)).join('&');
    const out = await gcs('GET', '/storage/v1/b/' + encodeURIComponent(t.bucket) + '/iam/testPermissions?' + q);
    granted = (out && out.permissions) || [];
  } catch (e) {
    console.error('[gcs] permission check failed: ' + String(e && e.message || e).split('\n')[0]);
    if (e.status === 404) throw userError('The Google Cloud Storage bucket ' + t.bucket + ' was not found. Check the folder link.');
    if (e.status === 401) throw userError('The capture service could not sign in to Google Cloud. Contact AaGeJa.');
    if (e.status === 403) throw userError(noAccess);
    throw userError('Google Cloud Storage could not be reached to check the folder. Try again in a moment.');
  }
  if (!NEEDED.every((p) => granted.includes(p))) throw userError(noAccess);
  const probe = (t.prefix ? t.prefix + '/' : '') + PROBE;
  try {
    await upload(t, probe, 'Written by the AaGeJa capture service to check it can save screenshots in this folder. It is replaced on every run and is safe to delete.\n', 'text/plain; charset=utf-8');
  } catch (e) {
    console.error('[gcs] check write failed: ' + String(e && e.message || e).split('\n')[0]);
    if (e.status === 401 || e.status === 403) throw userError(noAccess);
    throw userError('Google Cloud Storage could not be reached to check the folder. Try again in a moment.');
  }
  let r;
  try { r = await fetch(publicUrl(t, probe), { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(20000) }); } catch (_) {
    throw userError('Google Cloud Storage could not be reached to check the folder. Try again in a moment.');
  }
  try { await r.body?.cancel(); } catch (_) {}
  if (!r.ok) {
    throw userError('Files in ' + folder + ' cannot be opened without signing in. Storyboards and slide decks open the screenshots by link, so ask your Google Cloud administrator to give allUsers the Storage Object Viewer role on the bucket ' + t.bucket + '.');
  }
  return t;
}

/** The library.json already in the folder, read the way anyone would read it, or null. */
async function readLibrary(t) {
  const r = await fetch(publicUrl(t, (t.prefix ? t.prefix + '/' : '') + 'library.json'), { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(20000) });
  if (r.status === 404 || r.status === 403) { try { await r.body?.cancel(); } catch (_) {} return null; }
  if (!r.ok) throw Object.assign(new Error('GCS GET library.json returned ' + r.status), { status: r.status });
  try { return JSON.parse(await r.text()); } catch (_) { return null; }
}

/** @param {{path:string, content:Buffer, type:string}[]} files  paths are inside the folder. */
async function writeFiles(t, files) {
  for (const f of files) await upload(t, (t.prefix ? t.prefix + '/' : '') + f.path, f.content, f.type);
  return { written: files.length };
}

function saveError(e, t) {
  if (e && e.userMessage) return e.userMessage;
  const s = e && e.status;
  if (s === 401 || s === 403) return 'The capture service can no longer add files to gs://' + t.bucket + '/' + (t.prefix ? t.prefix + '/' : '') + '. Check it still has access.';
  return 'Google Cloud Storage did not accept the save. Try again in a moment.';
}

module.exports = { configured, isGcsLink, parseLink, checkTarget, readLibrary, writeFiles, publicUrl, accountName, saveError, PROBE };
