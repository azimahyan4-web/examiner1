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
  if (!actor) return res.status(403).json({ ok: false, error: 'Not authorized.' });

  const apiKey = await kvGet('config_apikey');
  if (!apiKey) return res.status(200).json({ ok: false, error: 'No Anthropic API key is set. Add one under Admin \u2192 AI marking settings.' });

  const submission = await kvGet(body.id);
  if (!submission || !submission.pages || !submission.pages.length) return res.status(404).json({ ok: false, error: 'Submission not found or has no pages.' });

  // A student may only trigger marking for their own submission (used by the
  // automatic marking flow); teachers/admin may trigger for anyone's.
  if (actor.role === 'student' && submission.student !== actor.username) return res.status(403).json({ ok: false, error: 'Not authorized.' });

  const scheme = await kvGet(schemeKey(submission.year, submission.session, submission.unit));
  if (!scheme) return res.status(200).json({ ok: false, error: 'No mark scheme found for this paper.' });

  let system = 'You are an exam marker. You will be given a mark scheme (as an image, PDF, or text) and a student\'s scanned answer pages. Read everything carefully, including handwriting, then grade the answer strictly against the mark scheme question by question, awarding partial credit where the scheme allows it. Do NOT write out any page-by-page notes, working, or analysis anywhere in your response \u2014 do all of that silently and output nothing but the final result. Your entire response must be a single raw JSON object and nothing else: no markdown, no code fences, no preamble, no explanation before or after it. Start your response immediately with { and end it with }, in this exact shape: {"score": <total marks awarded, number>, "max": <total marks available, number>, "feedback": "<2-4 sentences of overall constructive feedback written directly to the student>", "questions": [{"question": "<question number/label exactly as it appears on the paper, e.g. 1(a) or 6(b)(ii)>", "marksAwarded": <number>, "marksAvailable": <number>, "pointsAwarded": ["<short phrase for each mark scheme point the student correctly hit>"], "pointsMissed": ["<short phrase for each mark scheme point the student missed or got wrong>"]}]}. Include one entry in "questions" for every question or sub-part present in the mark scheme, in order. If a question has no distinct marking points (e.g. a single-mark MCQ), pointsAwarded/pointsMissed can just be a single short phrase each (or an empty array for whichever doesn\'t apply). The overall "score" and "max" must equal the sum of all the individual "marksAwarded" and "marksAvailable" values.';
  if (scheme.guidance) {
    system += '\n\nAdditional marking guidance from the teacher for this specific paper, which takes priority over your own judgement where it conflicts with the printed scheme: ' + scheme.guidance;
  }

  const content = [{ type: 'text', text: 'MARK SCHEME:' }];
  if (scheme.file.kind === 'text') {
    content.push({ type: 'text', text: scheme.file.content });
  } else if (scheme.file.kind === 'pdf') {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: scheme.file.base64 } });
  } else {
    content.push({ type: 'image', source: { type: 'base64', media_type: scheme.file.mediaType, data: scheme.file.base64 } });
  }
  content.push({ type: 'text', text: "STUDENT'S ANSWER (scanned pages, in order):" });
  submission.pages.forEach(p => content.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.base64 } }));

  // Vercel's infrastructure calls Anthropic directly — no proxy needed here,
  // unlike the EdgeOne version which was blocked at the network level.
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      thinking: { type: 'disabled' },
      system: system,
      messages: [{ role: 'user', content: content }]
    })
  });

  if (!anthropicRes.ok) {
    let detail = '';
    try { detail = (await anthropicRes.json()).error?.message || ''; } catch (e) {}
    return res.status(200).json({ ok: false, error: `Claude API error (${anthropicRes.status})${detail ? ': ' + detail : ''}` });
  }
  const data = await anthropicRes.json();
  const text = (data.content || []).map(b => b.text || '').join('').trim();
  let clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  // If Claude added any stray text around the JSON object, extract just the
  // {...} portion rather than requiring the whole reply to be valid JSON.
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    clean = clean.slice(firstBrace, lastBrace + 1);
  }
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: "Couldn't parse Claude's response.",
      rawResponsePreview: text || '(no text content in the response)',
      rawContentStructure: JSON.stringify((data.content || []).map(b => ({ type: b.type, textLength: b.text ? b.text.length : null }))),
      stopReason: data.stop_reason || null,
      usage: data.usage || null
    });
  }
  const score = Number(parsed.score);
  const max = Number(parsed.max) || 100;
  if (isNaN(score)) return res.status(200).json({ ok: false, error: "Claude's response didn't include a usable score." });
  const questions = Array.isArray(parsed.questions) ? parsed.questions.map(q => ({
    question: String(q.question || ''),
    marksAwarded: Number(q.marksAwarded) || 0,
    marksAvailable: Number(q.marksAvailable) || 0,
    pointsAwarded: Array.isArray(q.pointsAwarded) ? q.pointsAwarded.map(String) : [],
    pointsMissed: Array.isArray(q.pointsMissed) ? q.pointsMissed.map(String) : []
  })) : [];
  return res.status(200).json({ ok: true, score, max, feedback: String(parsed.feedback || ''), questions });
}

export const config = {
  maxDuration: 60
};
