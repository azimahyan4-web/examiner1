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
async function findAdmin(username, password) {
  if (String(username || '').trim().toLowerCase() !== 'admin') return null;
  const rec = await kvGet('user_admin');
  return (rec && rec.password === password) ? { role: 'admin', username: 'admin' } : null;
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
  const actor = await findAdmin(body.actorUsername, body.actorPassword);
  if (!actor) return res.status(403).json({ ok: false, error: 'Not authorized.' })

  if (body.action === 'status') {
    const key = await kvGet('config_apikey');
    return res.status(200).json({ ok: true, isSet: !!key })
  }
  if (body.action === 'set') {
    if (!body.apiKey) return res.status(200).json({ ok: false, error: 'Missing API key.' })
    await kvPut('config_apikey', body.apiKey);
    return res.status(200).json({ ok: true })
  }
  return res.status(400).json({ ok: false, error: 'Unknown action.' })
}
