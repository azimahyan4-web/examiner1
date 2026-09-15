# IAL Biology Marker — Vercel version

Same app, same Supabase database — this version runs entirely on Vercel
instead of EdgeOne + a separate proxy. Vercel's infrastructure can reach
Anthropic's API directly, so there's no proxy step needed at all.

## What changed from the EdgeOne version

- `functions/api/*.js` → `api/*.js` at the repo root (Vercel's convention).
- Each function now uses Vercel's Node-style handler:
  `export default async function handler(req, res) { ... }` instead of
  the Web-standard `onRequest({ request, env })` shape.
- Environment variables are read via `process.env.X` instead of `env.X`.
- `mark-with-ai.js` calls `https://api.anthropic.com/v1/messages` directly
  again — no `PROXY_URL`/`PROXY_SECRET` needed anymore.
- `index.html` is unchanged — it already called `/api/auth`, `/api/schemes`,
  etc., which matches Vercel's routing exactly.

## 1. Push this to GitHub

You can reuse your existing `ial-biology-marker` repo (replace its contents
with this structure) or make a fresh one — either works. The repo root must
contain `index.html` and the `api/` folder directly, not nested inside
another folder.

## 2. Import into Vercel

1. Go to vercel.com, sign in (GitHub sign-in is easiest).
2. "Add New" → "Project" → import the repo.
3. Framework preset: "Other" (it's not Next.js). No build command needed.
4. Deploy.

## 3. Set environment variables

In the Vercel project → Settings → Environment Variables, add:

- `SUPABASE_URL` — same value as before, e.g.
  `https://ymzxxzggxiiztqqwamne.supabase.co`
- `SUPABASE_SERVICE_KEY` — the same service_role key from Supabase

No proxy variables needed this time. Redeploy after adding these so they
take effect.

## 4. Test it

- Log in as `admin` / `admin`, change the password.
- Add your Anthropic API key under AI marking settings (use a freshly
  generated one — the one used during EdgeOne/Cloudflare/Val.town testing
  should already be revoked).
- Confirm a teacher can click "Mark with Claude" on a pending submission and
  actually get a result this time.

## Your Supabase data carries over

Since this version points at the exact same Supabase project and
`kv_store` table, none of your existing accounts, mark schemes, or
submissions are lost — only the hosting layer changed.
