'use strict';
/**
 * Environment connection tokens (aag_cp_...).
 *
 * The Connect page turns an environment address and its sign-in into one
 * token. The token IS the encrypted sign-in: nothing is stored anywhere, and
 * the agent only ever holds the token, so the password never reaches
 * MindStudio's run history. Same scheme as the Access Service's Gamma tokens
 * (gamma-proxy.js): AES-256-GCM, version || iv || tag || ciphertext, base64url.
 *
 * The key is derived from CAPTURE_KEY, so there is no extra secret to set.
 * Changing CAPTURE_KEY invalidates every token at once.
 */

const crypto = require('node:crypto');

const PREFIX = 'aag_cp_';
const VERSION = 1;
const TTL_DAYS = Number(process.env.CAPTURE_TOKEN_TTL_DAYS || 365);

let cached = null;
let cachedFor = null;

function key() {
  const secret = process.env.CAPTURE_KEY || '';
  if (secret.length < 16) throw new Error('CAPTURE_KEY is not set on the capture service.');
  if (cached && cachedFor === secret) return cached;
  cached = crypto.scryptSync(secret, 'aageja-capture-token-v1', 32);
  cachedFor = secret;
  return cached;
}

/** @returns {string} aag_cp_<base64url> */
function mint({ environment_url, username, password }) {
  const payload = JSON.stringify({ v: VERSION, e: environment_url, u: username, p: password, exp: Date.now() + TTL_DAYS * 86400000 });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(payload, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), ct]).toString('base64url');
}

const REASON = {
  malformed: 'The environment connection token is missing or incomplete. Copy it again from the Connect page.',
  invalid: 'The environment connection token is not valid. Create a new one on the Connect page.',
  expired: 'The environment connection token has expired. Create a new one on the Connect page.',
};

/** @returns {{ok:true, environment_url, username, password} | {ok:false, message}} */
function open(token) {
  const t = String(token || '').trim();
  if (!t.startsWith(PREFIX)) return { ok: false, message: REASON.malformed };
  let b;
  try { b = Buffer.from(t.slice(PREFIX.length), 'base64url'); } catch (_) { return { ok: false, message: REASON.malformed }; }
  if (b.length < 1 + 12 + 16 + 1 || b[0] !== VERSION) return { ok: false, message: REASON.malformed };
  let p;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(1, 13));
    d.setAuthTag(b.subarray(13, 29));
    p = JSON.parse(Buffer.concat([d.update(b.subarray(29)), d.final()]).toString('utf8'));
  } catch (_) {
    return { ok: false, message: REASON.invalid };
  }
  if (!p || !p.e) return { ok: false, message: REASON.invalid };
  if (typeof p.exp === 'number' && Date.now() > p.exp) return { ok: false, message: REASON.expired };
  return { ok: true, environment_url: p.e, username: p.u || '', password: p.p || '' };
}

module.exports = { mint, open, PREFIX };
