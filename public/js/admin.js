// Page de suivi : charge /api/admin/metrics avec le jeton saisi (jamais enregistré) et affiche un tableau par jour.
const $ = (id) => document.getElementById(id);
async function load() {
  $('msg').textContent = '';
  const res = await fetch(`/api/admin/metrics?days=${encodeURIComponent($('days').value)}`, { headers: { 'x-admin-token': $('token').value } });
  if (!res.ok) { $('msg').innerHTML = '<span class="err">Accès refusé ou suivi indisponible.</span>'; $('table').innerHTML = ''; return; }
  const { days, players } = await res.json();
  $('msg').textContent = `${players} personnages.`;
  const keys = [...new Set(days.flatMap((d) => Object.keys(d)))].filter((k) => k !== 'day');
  const head = `<tr><th>jour</th>${keys.map((k) => `<th>${k}</th>`).join('')}</tr>`;
  const rows = days.map((d) => `<tr><td>${d.day}</td>${keys.map((k) => `<td>${d[k] ?? ''}</td>`).join('')}</tr>`).join('');
  $('table').innerHTML = head + rows;
}
$('go').addEventListener('click', load);
