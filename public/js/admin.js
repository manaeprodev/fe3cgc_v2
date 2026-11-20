// Page de suivi : charge /api/admin/metrics avec le jeton saisi (jamais enregistré) et affiche un tableau par jour.
const $ = (id) => document.getElementById(id);
async function load() {
  $('msg').textContent = '';
  const res = await fetch(`/api/admin/metrics?days=${encodeURIComponent($('days').value)}`, { headers: { 'x-admin-token': $('token').value } });
  if (!res.ok) { $('msg').innerHTML = '<span class="err">Accès refusé ou suivi indisponible.</span>'; $('table').innerHTML = ''; return; }
  const { days, players, bugs = [] } = await res.json();
  $('msg').textContent = `${players} personnages.`;
  const keys = [...new Set(days.flatMap((d) => Object.keys(d)))].filter((k) => k !== 'day');
  const head = `<tr><th>jour</th>${keys.map((k) => `<th>${k}</th>`).join('')}</tr>`;
  const rows = days.map((d) => `<tr><td>${d.day}</td>${keys.map((k) => `<td>${d[k] ?? ''}</td>`).join('')}</tr>`).join('');
  $('table').innerHTML = head + rows;
  const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  $('bugs').innerHTML = bugs.length ? bugs.map((b) => `<li><b>${esc(b.pseudo || '?')}</b> · ${esc(b.created_at.slice(0, 16).replace('T', ' '))}${b.emailed ? ' · envoyé' : ''}<br>${esc(b.message)}</li>`).join('') : '<li>Aucun signalement.</li>';
}
$('go').addEventListener('click', load);
