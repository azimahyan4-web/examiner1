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
async function kvListKeysOnly(prefix) {
  const res = await fetch(process.env.SUPABASE_URL + '/rest/v1/kv_store?key=like.' + encodeURIComponent(prefix) + '*&select=key', { headers: sbHeaders() });
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}
async function kvList(prefix) {
  const res = await fetch(process.env.SUPABASE_URL + '/rest/v1/kv_store?key=like.' + encodeURIComponent(prefix) + '*&select=key,value', { headers: sbHeaders() });
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}
async function kvListMarksMeta(prefix) {
  // Reads from a view that strips the heavy `pages` field server-side, so
  // listing someone's submissions never has to transfer all their scanned
  // images at once — that's what was causing oversized-response failures.
  const res = await fetch(process.env.SUPABASE_URL + '/rest/v1/kv_marks_meta?key=like.' + encodeURIComponent(prefix) + '*&select=key,value', { headers: sbHeaders() });
  if (!res.ok) throw new Error('Could not load results (' + res.status + ').');
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
  const actor = await findActor(body.actorUsername, body.actorPassword);
  if (!actor) return res.status(403).json({ ok: false, error: 'Not authorized.' })

  if (body.action === 'submit') {
    if (actor.role !== 'student') return res.status(403).json({ ok: false, error: 'Only students can submit.' })
    const { year, session: sessionVal, unit, question } = body;
    if (!year || !sessionVal || !unit) return res.status(200).json({ ok: false, error: 'Missing paper details.' })
    const id = 'mark_' + keySafe(actor.username) + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const record = {
      student: actor.username, year, session: sessionVal, unit, question: question || 'Whole paper',
      status: 'pending', score: null, max: null, feedback: null, questions: [],
      gradedBy: null, markedByAI: false, date: new Date().toISOString().slice(0, 10)
    };
    try {
      await kvPut(id, record);
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Could not save your submission — please try again.' })
    }
    // This creates an empty record only. Pages are uploaded separately via
    // "add-page" below, each as its OWN independent database entry (not
    // appended into this record). That means every page upload can happen
    // in parallel with no risk of two uploads overwriting each other, and
    // no single request ever carries more than one page — comfortably under
    // Vercel's fixed 4.5MB per-request limit regardless of page count.
    return res.status(200).json({ ok: true, id })
  }

  if (body.action === 'add-page') {
    if (actor.role !== 'student') return res.status(403).json({ ok: false, error: 'Only students can upload pages.' })
    const { id, pageIndex, page } = body;
    if (!id || !id.startsWith('mark_')) return res.status(400).json({ ok: false, error: 'Invalid submission id.' })
    if (typeof pageIndex !== 'number' || pageIndex < 0) return res.status(400).json({ ok: false, error: 'Invalid page index.' })
    if (!page || !page.base64) return res.status(200).json({ ok: false, error: 'Missing page data.' })
    const rec = await kvGet(id);
    if (!rec) return res.status(404).json({ ok: false, error: 'Submission not found.' })
    if (rec.student !== actor.username) return res.status(403).json({ ok: false, error: 'Not authorized.' })
    if (rec.status !== 'pending') return res.status(200).json({ ok: false, error: 'This submission has already been marked.' })
    const paddedIndex = String(pageIndex).padStart(4, '0');
    try {
      await kvPut(id + '_page_' + paddedIndex, { name: page.name, mediaType: page.mediaType, base64: page.base64 });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Could not save this page — please try again.' })
    }
    return res.status(200).json({ ok: true })
  }

  if (body.action === 'list') {
    const prefix = actor.role === 'student' ? 'mark_' + keySafe(actor.username) + '_' : 'mark_';
    const rows = await kvListMarksMeta(prefix);
    // Only count pages for pending submissions (a small set) — marked ones
    // don't need it since their pages are already cleaned up after marking.
    const marks = [];
    for (const r of rows) {
      const m = { id: r.key, ...r.value };
      if (m.status === 'pending') {
        const pageRows = await kvListKeysOnly(r.key + '_page_');
        m.pageCount = pageRows.length;
      }
      marks.push(m);
    }
    return res.status(200).json({ ok: true, marks })
  }

  if (body.action === 'save') {
    const { id, score, max, feedback, questions } = body;
    if (!id || !id.startsWith('mark_')) return res.status(400).json({ ok: false, error: 'Invalid submission id.' })
    const rec = await kvGet(id);
    if (!rec) return res.status(404).json({ ok: false, error: 'Submission not found.' })
    // Students may only finalize their own submission (used for the automatic
    // marking flow); teachers/admin may finalize anyone's.
    if (actor.role === 'student' && rec.student !== actor.username) return res.status(403).json({ ok: false, error: 'Not authorized.' })
    rec.status = 'marked';
    rec.score = score;
    rec.max = max;
    rec.feedback = feedback;
    rec.questions = Array.isArray(questions) ? questions : [];
    rec.gradedBy = actor.role === 'student' ? 'Claude (automatic)' : actor.username;
    rec.markedByAI = true;
    rec.markedDate = new Date().toISOString().slice(0, 10);
    await kvPut(id, rec);
    // Clean up the now-unneeded page images to keep storage usage down.
    const pageRows = await kvListKeysOnly(id + '_page_');
    await Promise.all(pageRows.map(p => kvDelete(p.key)));
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
