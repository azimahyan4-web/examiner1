export default async function handler(req, res) {
  const out = {
    hasUrl: !!process.env.SUPABASE_URL,
    hasKey: !!process.env.SUPABASE_SERVICE_KEY,
    urlPreview: process.env.SUPABASE_URL ? JSON.stringify(process.env.SUPABASE_URL) : null,
    urlLength: process.env.SUPABASE_URL ? process.env.SUPABASE_URL.length : null
  };
  try {
    const testUrl = process.env.SUPABASE_URL + '/rest/v1/kv_store?select=key&limit=1';
    out.attemptedUrl = testUrl;
    const r = await fetch(testUrl, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
      }
    });
    out.status = r.status;
    out.body = (await r.text()).slice(0, 500);
  } catch (e) {
    out.errorMessage = e && e.message ? e.message : String(e);
    out.errorCause = e && e.cause ? String(e.cause) : null;
    out.errorCauseCode = e && e.cause && e.cause.code ? e.cause.code : null;
    out.errorStack = e && e.stack ? String(e.stack).slice(0, 800) : null;
  }
  res.status(200).json(out);
}
