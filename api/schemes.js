function keySafe(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
}
function sbHeaders() {
  return { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
}
async function kvGet(key) {
  const res = await fetch(process.env.SUPABASE_URL + '/rest/v1/kv_store?key=eq.' + encodeURIComponent(key) + '&select=value', { headers: sbHeaders() });
  const rows = await res.json();
  return (Array.isArray(rows) && rows[0]) ? rows[0].value : null;
}
async function kvPut(key, value) {
  const res = await fetch(process.env.SUPABASE_URL + '/rest/v1/kv_store?on_conflict=key', {
    method: 'POST',
    headers: Object.assign({}, sbHeaders(), { Prefer: 'resolution=merge-duplicates' }),
    body: JSON.stringify({ key, value })
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (e) {}
    throw new Error('Supabase write failed (' + res.status + '): ' + detail.slice(0, 300));
  }
}
async function kvDelete(key) {
  await fetch(process.env.SUPABASE_URL + '/rest/v1/kv_store?key=eq.' + encodeURIComponent(key), { method: 'DELETE', headers: sbHeaders() });
}
async function kvListSchemesMeta(prefix) {
  // Reads from a view that strips the heavy file content (the actual PDF/
  // image bytes) server-side, so listing every scheme never has to transfer
  // dozens of full files at once — same class of fix as the marks list.
  const res = await fetch(process.env.SUPABASE_URL + '/rest/v1/kv_schemes_meta?key=like.' + encodeURIComponent(prefix) + '*&select=key,value', { headers: sbHeaders() });
  if (!res.ok) throw new Error('Could not load schemes (' + res.status + ').');
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}
async function findActor(username, password) {
  const uname = keySafe(username);
  if (uname === 'admin') {
    const rec = await kvGet('user_admin');
    return (rec && rec.password === password) ? { role: 'admin', username: 'admin' } : null;
  }
  let rec = await kvGet('user_teacher_' + uname);
  if (rec) return rec.password === password ? { role: 'teacher', username: rec.username } : null;
  rec = await kvGet('user_student_' + uname);
  if (rec) return rec.password === password ? { role: 'student', username: rec.username } : null;
  return null;
}
function schemeKey(year, sessionVal, unit) {
  return 'scheme_' + year + '_' + keySafe(sessionVal) + '_' + keySafe(unit);
}

export default async function handler(req, res) {
  try {
    return await handleRequest(req, res);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Unexpected server error: ' + (e && e.message ? e.message : String(e)) });
  }
}

async function handleRequest(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body || {};
  const actor = await findActor(body.actorUsername, body.actorPassword);
  if (!actor || actor.role === 'student') return res.status(403).json({ ok: false, error: 'Not authorized.' })

  if (body.action === 'list') {
    const rows = await kvListSchemesMeta('scheme_');
    return res.status(200).json({ ok: true, schemes: rows.map(r => r.value) })
  }

  if (body.action === 'get') {
    const { year, session: sessionVal, unit } = body;
    const record = await kvGet(schemeKey(year, sessionVal, unit));
    if (!record) return res.status(404).json({ ok: false, error: 'Scheme not found.' })
    return res.status(200).json({ ok: true, scheme: record })
  }

  if (body.action === 'upsert') {
    const { year, session: sessionVal, unit, file } = body;
    if (!year || !sessionVal || !unit || !file) return res.status(200).json({ ok: false, error: 'Missing year, session, unit or file.' })
    const key = schemeKey(year, sessionVal, unit);
    const existing = await kvGet(key);
    const record = { year, session: sessionVal, unit, file, guidance: existing ? existing.guidance : '', createdBy: actor.username, date: new Date().toISOString().slice(0, 10) };
    await kvPut(key, record);
    return res.status(200).json({ ok: true })
  }

  if (body.action === 'update-guidance') {
    const { year, session: sessionVal, unit, guidance } = body;
    const key = schemeKey(year, sessionVal, unit);
    const existing = await kvGet(key);
    if (!existing) return res.status(404).json({ ok: false, error: 'Scheme not found.' })
    existing.guidance = guidance || '';
    await kvPut(key, existing);
    return res.status(200).json({ ok: true })
  }

  if (body.action === 'remove') {
    const { year, session: sessionVal, unit } = body;
    await kvDelete(schemeKey(year, sessionVal, unit));
    return res.status(200).json({ ok: true })
  }

  return res.status(400).json({ ok: false, error: 'Unknown action.' })
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '25mb'
    }
  }
};
