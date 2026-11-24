// Teste la confirmation d'adresse email à l'inscription et l'envoi des signalements de bugs, avec un faux serveur SMTP local.
// Usage : node tests/email.test.js <server.js> <dossier de données temporaire>
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3121;
const SMTP_PORT = 2526;
let failures = 0;
let total = 0;
const check = (label, ok, detail = '') => { total += 1; if (!ok) failures += 1; console.log(`${ok ? 'ok  ' : 'ÉCHEC'} ${label}${detail !== '' ? ' — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Faux serveur SMTP : accepte tout et garde les messages reçus.
const mails = [];
const smtp = net.createServer((sock) => {
  let buf = '';
  let step = 'cmd';
  let data = [];
  let rcpt = '';
  sock.write('220 faux SMTP\r\n');
  sock.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (step === 'data') {
        if (line === '.') { mails.push({ to: rcpt, raw: data.join('\n') }); data = []; step = 'cmd'; sock.write('250 reçu\r\n'); } else data.push(line);
      } else if (step === 'user') { step = 'pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); }
      else if (step === 'pass') { step = 'cmd'; sock.write('235 ok\r\n'); }
      else if (/^EHLO/i.test(line)) sock.write('250-bonjour\r\n250 AUTH LOGIN\r\n');
      else if (/^AUTH LOGIN/i.test(line)) { step = 'user'; sock.write('334 VXNlcm5hbWU6\r\n'); }
      else if (/^MAIL FROM/i.test(line)) sock.write('250 ok\r\n');
      else if (/^RCPT TO/i.test(line)) { rcpt = line.replace(/^RCPT TO:<|>$/gi, ''); sock.write('250 ok\r\n'); }
      else if (/^DATA/i.test(line)) { step = 'data'; sock.write('354 go\r\n'); }
      else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 ok\r\n');
    }
  });
});
const bodyOf = (raw) => { const parts = raw.split('\n\n'); return Buffer.from(parts.slice(1).join('').replace(/\s/g, ''), 'base64').toString('utf8'); };

function client() {
  let cookie = '';
  return async (p, body) => {
    const r = await fetch(`http://localhost:${PORT}/api${p}`, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { s: r.status, d: await r.json() };
  };
}

let server;
(async () => {
  try {
    await new Promise((ok) => smtp.listen(SMTP_PORT, ok));
    server = spawn(process.execPath, [serverFile], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_USER: 'jeu@example.test', SMTP_PASS: 'secret', SMTP_INSECURE: '1', EMAIL_VERIFY: '1', BUG_REPORT_TO: 'equipe@example.test' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await sleep(1500);

    console.log('# Confirmation de l\'adresse');
    const a = client();
    let r = await a('/register', { email: 'nouveau@example.test', password: 'mot-de-passe-1', passwordConfirm: 'mot-de-passe-1' });
    check('inscription : adresse à confirmer', r.s === 201 && r.d.user.verified === false, JSON.stringify(r.d.user));
    await sleep(500);
    check('un email part vers l\'adresse du joueur', mails.length === 1 && mails[0].to === 'nouveau@example.test', JSON.stringify(mails.map((m) => m.to)));
    const code = (bodyOf(mails[0].raw).match(/\b(\d{6})\b/) || [])[1];
    check('il contient un code à 6 chiffres (et le sujet le reprend)', !!code && /Subject: =\?UTF-8\?B\?/.test(mails[0].raw), String(code));
    r = await a('/character', { pseudo: 'Novice', birthday: '1995-04-12', class: 'soldier', avatar: 'avatar_1.webp', faction: 'rouge' });
    check('pas de personnage avant confirmation', r.s === 403 && r.d.error === 'email_unverified', JSON.stringify(r.d));
    r = await a('/verify/resend', {});
    check('pas de nouveau code avant une minute', r.s === 429 && r.d.error === 'code_wait');
    r = await a('/verify', { code: code === '000000' ? '111111' : '000000' });
    check('mauvais code refusé', r.s === 400 && r.d.error === 'code_invalid');
    r = await a('/verify', { code });
    check('bon code : adresse confirmée', r.s === 200 && r.d.user.verified === true, JSON.stringify(r.d.user));
    r = await a('/character', { pseudo: 'Novice', birthday: '1995-04-12', class: 'soldier', avatar: 'avatar_1.webp', faction: 'rouge' });
    check('le personnage peut alors être créé', r.s === 201, JSON.stringify(r.d.error));
    r = await a('/me');
    check('la confirmation est durable', r.d.user.verified === true);
    // Essais limités.
    const b = client();
    await b('/register', { email: 'autre@example.test', password: 'mot-de-passe-2', passwordConfirm: 'mot-de-passe-2' });
    await sleep(400);
    for (let i = 0; i < 5; i += 1) await b('/verify', { code: 'abcdef' });
    r = await b('/verify', { code: (bodyOf(mails[mails.length - 1].raw).match(/\b(\d{6})\b/) || [])[1] });
    check('5 essais au plus, même le bon code est alors refusé', r.s === 429 && r.d.error === 'code_attempts', JSON.stringify(r.d));

    console.log('# Signalement de bug par email');
    const before = mails.length;
    r = await a('/bug', { message: 'La carte ne se centre pas sur ma position.' });
    await sleep(600);
    const bug = mails[before];
    check('le signalement part par email vers l\'équipe, avec le pseudo et le message', r.s === 200 && bug && bug.to === 'equipe@example.test' && /Novice/.test(bodyOf(bug.raw)) && /ne se centre pas/.test(bodyOf(bug.raw)), bug ? bodyOf(bug.raw).slice(0, 120) : 'aucun');
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
    if (server && server.exitCode === null) server.kill();
    smtp.close();
  }
})();
