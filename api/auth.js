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
async function kvList(prefix) {
  const res = await fetch(process.env.SUPABASE_URL + '/rest/v1/kv_store?key=like.' + encodeURIComponent(prefix) + '*&select=key,value', { headers: sbHeaders() });
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
  const { action } = body;

  // First-run bootstrap: make sure the admin account exists.
  let adminRec = await kvGet('user_admin');
  if (!adminRec) {
    adminRec = { password: 'admin' };
    await kvPut('user_admin', adminRec);
  }

  if (action === 'login') {
    const actor = await findActor(body.username, body.password);
    if (!actor) {
      const uname = keySafe(body.username);
      const known = uname === 'admin'
        || !!(await kvGet('user_teacher_' + uname))
        || !!(await kvGet('user_student_' + uname));
      return res.status(200).json({ ok: false, error: known ? 'Incorrect password.' : 'No account found with that username.' })
    }
    return res.status(200).json({ ok: true, role: actor.role, username: actor.username })
  }

  if (action === 'change-password') {
    const actor = await findActor(body.username, body.currentPassword);
    if (!actor) return res.status(200).json({ ok: false, error: 'Current password is incorrect.' })
    if (!body.newPassword || body.newPassword.length < 6) return res.status(200).json({ ok: false, error: 'New password must be at least 6 characters.' })
    const key = actor.role === 'admin' ? 'user_admin' : 'user_' + actor.role + '_' + keySafe(actor.username);
    const rec = await kvGet(key);
    rec.password = body.newPassword;
    await kvPut(key, rec);
    return res.status(200).json({ ok: true })
  }

  if (action === 'give-access') {
    const actor = await findActor(body.actorUsername, body.actorPassword);
    if (!actor || actor.role === 'student') return res.status(403).json({ ok: false, error: 'Not authorized.' })
    if (body.role === 'teacher' && actor.role !== 'admin') return res.status(403).json({ ok: false, error: 'Only admin can add teachers.' })
    if (!['teacher', 'student'].includes(body.role)) return res.status(400).json({ ok: false, error: 'Invalid role.' })
    const name = (body.name || '').trim();
    const password = body.password || '';
    if (!name) return res.status(200).json({ ok: false, error: 'Enter a name.' })
    if (password.length < 6) return res.status(200).json({ ok: false, error: 'Password must be at least 6 characters.' })
    const lname = keySafe(name);
    const clash = lname === 'admin'
      || (await kvGet('user_teacher_' + lname))
      || (await kvGet('user_student_' + lname));
    if (clash) return res.status(200).json({ ok: false, error: 'That name is already in use by another account.' })
    await kvPut('user_' + body.role + '_' + lname, { username: name, password });
    return res.status(200).json({ ok: true })
  }

  if (action === 'remove-user') {
    const actor = await findActor(body.actorUsername, body.actorPassword);
    if (!actor || actor.role === 'student') return res.status(403).json({ ok: false, error: 'Not authorized.' })
    if (body.role === 'teacher' && actor.role !== 'admin') return res.status(403).json({ ok: false, error: 'Only admin can remove teachers.' })
    await kvDelete('user_' + body.role + '_' + keySafe(body.name));
    return res.status(200).json({ ok: true })
  }

  if (action === 'list-users') {
    const actor = await findActor(body.actorUsername, body.actorPassword);
    if (!actor || actor.role === 'student') return res.status(403).json({ ok: false, error: 'Not authorized.' })
    const teacherRows = await kvList('user_teacher_');
    const studentRows = await kvList('user_student_');
    return res.status(200).json({ ok: true, teachers: teacherRows.map(r => r.value.username), students: studentRows.map(r => r.value.username) })
  }

  return res.status(400).json({ ok: false, error: 'Unknown action.' })
}
