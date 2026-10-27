'use strict';
/**
 * The Connect page: turns an environment address and its sign-in into an
 * environment connection token for the Screenshot Library Builder agent.
 * Self-contained HTML; no scripts or fonts from other sites.
 */

function page() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect an Environment · AaGeJa</title>
<style>
  :root { --ink:#0A1628; --teal:#0D7377; --gold:#F0B429; --cream:#F5F0E8; --line:#E4DDD0; --slate:#5A6A7E; --muted:#9AAABB; --tealbg:#E6FFFA; --tealline:#B2E8E0; --err:#B91C1C; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--cream); color:var(--ink); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { background:#fff; border-bottom:1px solid var(--line); padding:18px 24px 16px; }
  .wrap { max-width:660px; margin:0 auto; }
  .brand { font-weight:700; font-size:14px; display:flex; align-items:center; gap:8px; margin-bottom:8px; }
  .brand i { width:7px; height:7px; border-radius:50%; background:var(--gold); display:inline-block; }
  .brand b { color:var(--gold); }
  h1 { font-family: Georgia, serif; font-weight:600; font-size:30px; margin:0; letter-spacing:-0.01em; }
  main { padding:28px 24px 48px; }
  .step { display:flex; gap:18px; margin-bottom:26px; }
  .num { flex:0 0 auto; width:28px; height:28px; border-radius:50%; background:var(--teal); color:#fff; font-size:12px; display:flex; align-items:center; justify-content:center; margin-top:2px; }
  .step-body { flex:1; min-width:0; }
  .step-title { font-size:15px; font-weight:600; margin-bottom:6px; }
  p { font-size:13.5px; color:var(--slate); line-height:1.6; margin:0 0 12px; }
  label { display:block; font-size:13px; font-weight:600; margin:14px 0 6px; }
  input, textarea { width:100%; font:inherit; font-size:14px; color:var(--ink); background:#fff; border:1.5px solid var(--line); border-radius:9px; padding:10px 13px; outline:none; }
  input:focus, textarea:focus { border-color:var(--teal); box-shadow:0 0 0 3px rgba(13,115,119,0.1); }
  textarea { font-family: ui-monospace, Menlo, Consolas, monospace; font-size:12px; height:96px; resize:vertical; word-break:break-all; }
  .actions { display:flex; align-items:center; gap:12px; margin-top:16px; }
  button { background:var(--teal); color:#fff; border:none; border-radius:10px; padding:11px 20px; font:inherit; font-size:14px; font-weight:600; cursor:pointer; }
  button:disabled { background:var(--line); cursor:wait; }
  .msg { font-size:13px; color:var(--err); margin-top:10px; display:none; }
  .result { display:none; background:var(--tealbg); border:1px solid var(--tealline); border-radius:12px; padding:18px 20px; margin:0 0 26px; }
  .result-title { font-size:14px; font-weight:600; margin-bottom:8px; }
  .privacy { background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px 18px; font-size:12.5px; color:var(--slate); line-height:1.6; }
  .privacy strong { color:var(--ink); }
</style></head>
<body>
<header><div class="wrap">
  <div class="brand"><i></i><span>Aa<b>Ge</b>Ja</span></div>
  <h1>Connect an Environment</h1>
</div></header>
<main><div class="wrap">

  <div class="step"><div class="num">1</div><div class="step-body">
    <div class="step-title">Enter the environment and its sign-in</div>
    <p>The address of the page where you sign in, and the username and password of an account that can see the screens you want captured. Use a training or demo environment.</p>
    <form id="f" autocomplete="off">
      <label for="env">Environment address</label>
      <input id="env" type="url" placeholder="https://" spellcheck="false" required>
      <label for="user">Username</label>
      <input id="user" type="text" spellcheck="false" autocapitalize="off" required>
      <label for="pass">Password</label>
      <input id="pass" type="password" autocomplete="new-password" required>
      <div class="actions"><button id="go" type="submit">Create token</button></div>
      <div class="msg" id="msg" role="alert"></div>
    </form>
  </div></div>

  <div class="result" id="result">
    <div class="result-title">Your environment connection token</div>
    <textarea id="token" readonly></textarea>
    <div class="actions"><button id="copy" type="button">Copy</button></div>
    <p style="margin:12px 0 0">Treat it like a password. It works only for this environment and only with AaGeJa's screenshot capture. When the password changes, create a new token.</p>
  </div>

  <div class="step"><div class="num">2</div><div class="step-body">
    <div class="step-title">Paste the token into the agent</div>
    <p>Enter it in the <strong>Environment Connection Token</strong> field of the Screenshot Library Builder.</p>
  </div></div>

  <div class="privacy">
    <strong>What happens to your sign-in.</strong> It is encrypted the moment it arrives. It is never written to disk, never logged and never sent to any AI platform. The token is the encrypted sign-in, and only the capture service can read it, in memory, while it captures your screens.
  </div>

</div></main>
<script>
(function () {
  var f = document.getElementById('f'), go = document.getElementById('go'), msg = document.getElementById('msg');
  function fail(t) { msg.textContent = t; msg.style.display = 'block'; }
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    msg.style.display = 'none';
    go.disabled = true; go.textContent = 'Creating…';
    fetch('/connect/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        environment_url: document.getElementById('env').value.trim(),
        username: document.getElementById('user').value,
        password: document.getElementById('pass').value
      })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.token) return fail(j.error || 'The token could not be created.');
      document.getElementById('pass').value = '';
      document.getElementById('token').value = j.token;
      document.getElementById('result').style.display = 'block';
      document.getElementById('result').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }).catch(function () { fail('The token could not be created. Check your connection and try again.'); })
      .then(function () { go.disabled = false; go.textContent = 'Create token'; });
  });
  document.getElementById('copy').addEventListener('click', function () {
    var t = document.getElementById('token'), b = this;
    t.select();
    (navigator.clipboard ? navigator.clipboard.writeText(t.value) : Promise.reject()).catch(function () { document.execCommand('copy'); })
      .then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); });
  });
})();
</script>
</body></html>`;
}

module.exports = { page };
