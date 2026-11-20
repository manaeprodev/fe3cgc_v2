'use strict';
// Envoi de mails sans dépendance (SMTP avec authentification), pour les signalements de bugs.
// Réglages par variables d'environnement : SMTP_HOST, SMTP_PORT (465 : TLS direct, sinon STARTTLS), SMTP_USER, SMTP_PASS,
// SMTP_FROM (facultatif, sinon SMTP_USER). Avec Gmail : smtp.gmail.com, port 465, et un « mot de passe d'application ».

const net = require('node:net');
const tls = require('node:tls');

const configured = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Lit les réponses du serveur : une réponse se termine par une ligne « 250 texte » (code suivi d'une espace).
function reader(socket) {
  let buf = '';
  const waiting = [];
  const lines = [];
  const flush = () => {
    while (waiting.length) {
      const end = lines.findIndex((l) => /^\d{3} /.test(l));
      if (end < 0) return;
      const chunk = lines.splice(0, end + 1);
      waiting.shift()({ code: Number(chunk[end].slice(0, 3)), text: chunk.join('\n') });
    }
  };
  const onData = (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 2); }
    flush();
  };
  socket.on('data', onData);
  return {
    next: () => new Promise((resolve) => { waiting.push(resolve); flush(); }),
    detach: () => socket.off('data', onData),
  };
}

async function send({ to, subject, text }) {
  if (!configured()) throw new Error('smtp_not_configured');
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 465;
  const user = process.env.SMTP_USER;
  const from = process.env.SMTP_FROM || user;
  // SMTP_INSECURE=1 : connexion sans chiffrement, uniquement pour les tests avec un faux serveur local.
  const insecure = process.env.SMTP_INSECURE === '1';
  let socket = port === 465 && !insecure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  socket.setTimeout(20_000, () => socket.destroy(new Error('smtp_timeout')));
  await new Promise((ok, ko) => { socket.once(port === 465 && !insecure ? 'secureConnect' : 'connect', ok); socket.once('error', ko); });
  let r = reader(socket);
  const expect = async (codes) => {
    const res = await r.next();
    if (!codes.includes(res.code)) throw new Error(`smtp ${res.code}: ${res.text.slice(0, 200)}`);
    return res;
  };
  const cmd = async (line, codes) => { socket.write(`${line}\r\n`); return expect(codes); };
  try {
    await expect([220]);
    await cmd('EHLO three-crowns', [250]);
    if (port !== 465 && !insecure) {
      await cmd('STARTTLS', [220]);
      r.detach();
      socket = tls.connect({ socket, servername: host });
      await new Promise((ok, ko) => { socket.once('secureConnect', ok); socket.once('error', ko); });
      r = reader(socket);
      await cmd('EHLO three-crowns', [250]);
    }
    await cmd('AUTH LOGIN', [334]);
    await cmd(b64(user), [334]);
    await cmd(b64(process.env.SMTP_PASS), [235]);
    await cmd(`MAIL FROM:<${from}>`, [250]);
    await cmd(`RCPT TO:<${to}>`, [250, 251]);
    await cmd('DATA', [354]);
    const body = b64(text).replace(/.{1,76}/g, '$&\r\n');
    const msg = [
      `From: Three Crowns <${from}>`, `To: <${to}>`, `Subject: =?UTF-8?B?${b64(subject)}?=`, `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body,
    ].join('\r\n');
    await cmd(`${msg}\r\n.`, [250]);
    await cmd('QUIT', [221]).catch(() => {});
  } finally {
    socket.end();
  }
}

module.exports = { send, configured };
