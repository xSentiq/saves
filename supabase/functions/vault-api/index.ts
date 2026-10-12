// Peak Vault API – the only door into the vault data.
//
// POST JSON { action, ... }
//   config                      → { names }            (who can log in)
//   login  { passcode, name }   → { token, name }      (token valid 30 days)
//   list   { token }            → { items }            (files come with 6 h signed URLs)
//   rate   { token, id, score } → { ok }               (score 1–5, or 0 to clear)
//   note   { token, id, note, scope? } → { ok }        (scope "shared" = note both can edit,
//                                                      "personal" = your own note, read-only for others)
//   remove { token, id }        → { ok }               (deletes item + file)
//
// Env (Supabase → Edge Functions → Secrets):
//   VAULT_PASSCODE   – the shared passcode. Changing it logs everyone out.
//   VAULT_NAMES      – comma-separated names to pick from, default "Sentiq,furfyl"

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const BUCKET = "vault";
const TOKEN_DAYS = 30;
const MAX_FAILS = 8;          // per IP …
const FAIL_WINDOW_MIN = 15;   // … per 15 minutes

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const names = () =>
  (Deno.env.get("VAULT_NAMES") || "Sentiq,furfyl").split(",").map((s) => s.trim()).filter(Boolean);

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) =>
  atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));

// Signing key depends on the passcode → changing VAULT_PASSCODE invalidates all sessions.
async function hmacKey() {
  const material = `${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}|vault|${Deno.env.get("VAULT_PASSCODE")}`;
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(material));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function makeToken(name: string) {
  const payload = b64url(enc.encode(JSON.stringify({ n: name, e: Date.now() + TOKEN_DAYS * 864e5 })));
  const sig = b64url(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(payload)));
  return `${payload}.${sig}`;
}

async function readToken(token: unknown): Promise<string | null> {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  try {
    const sigBytes = Uint8Array.from(fromB64url(sig), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(), sigBytes, enc.encode(payload));
    if (!ok) return null;
    const { n, e } = JSON.parse(fromB64url(payload));
    if (typeof e !== "number" || e < Date.now() || !names().includes(n)) return null;
    return n;
  } catch {
    return null;
  }
}

async function sameSecret(a: string, b: string) {
  // constant-time compare via hashing
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function clientIp(req: Request) {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.headers.get("cf-connecting-ip") || "unknown";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = body.action;

  if (action === "config") return json({ names: names() });

  if (action === "login") {
    const passcode = Deno.env.get("VAULT_PASSCODE");
    if (!passcode) return json({ error: "Vault isn't set up yet (no VAULT_PASSCODE)." }, 503);

    const ip = clientIp(req);
    const since = new Date(Date.now() - FAIL_WINDOW_MIN * 60e3).toISOString();
    const { count } = await supabase.from("vault_login_attempts")
      .select("id", { count: "exact", head: true }).eq("ip", ip).gte("attempted_at", since);
    if ((count ?? 0) >= MAX_FAILS) return json({ error: "Too many wrong tries. Wait 15 minutes." }, 429);

    const name = String(body.name || "");
    if (!names().includes(name)) return json({ error: "Pick who you are." }, 400);

    if (!(await sameSecret(String(body.passcode || ""), passcode))) {
      await supabase.from("vault_login_attempts").insert({ ip });
      await new Promise((r) => setTimeout(r, 600));
      return json({ error: "Wrong passcode." }, 401);
    }
    return json({ token: await makeToken(name), name });
  }

  const who = await readToken(body.token);
  if (!who) return json({ error: "locked" }, 401);

  if (action === "list") {
    const [{ data: items, error }, { data: ratings }, { data: pnotes }] = await Promise.all([
      supabase.from("vault_items").select("*").order("created_at", { ascending: false }).limit(2000),
      supabase.from("vault_ratings").select("item_id, rater, score"),
      supabase.from("vault_personal_notes").select("item_id, author, note, updated_at"),
    ]);
    if (error) return json({ error: error.message }, 500);

    const byItem: Record<string, Record<string, number>> = {};
    for (const r of ratings || []) (byItem[r.item_id] ||= {})[r.rater] = r.score;
    const notesByItem: Record<string, Record<string, { note: string; updated_at: string }>> = {};
    for (const n of pnotes || []) (notesByItem[n.item_id] ||= {})[n.author] = { note: n.note, updated_at: n.updated_at };

    const paths = (items || []).map((i) => i.storage_path).filter(Boolean) as string[];
    const urls: Record<string, string> = {};
    for (let k = 0; k < paths.length; k += 500) {
      const { data } = await supabase.storage.from(BUCKET).createSignedUrls(paths.slice(k, k + 500), 6 * 3600);
      for (const s of data || []) if (s.path && s.signedUrl) urls[s.path] = s.signedUrl;
    }

    return json({
      you: who,
      names: names(),
      items: (items || []).map((i) => ({
        ...i,
        file_url: i.storage_path ? urls[i.storage_path] ?? null : null,
        ratings: byItem[i.id] || {},
        personal_notes: notesByItem[i.id] || {},
      })),
    });
  }

  const id = String(body.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "bad id" }, 400);

  if (action === "rate") {
    const score = Number(body.score);
    if (score === 0) {
      await supabase.from("vault_ratings").delete().eq("item_id", id).eq("rater", who);
      return json({ ok: true });
    }
    if (!Number.isInteger(score) || score < 1 || score > 5) return json({ error: "score 1-5" }, 400);
    const { error } = await supabase.from("vault_ratings")
      .upsert({ item_id: id, rater: who, score, updated_at: new Date().toISOString() });
    return error ? json({ error: error.message }, 500) : json({ ok: true });
  }

  if (action === "note") {
    // scope "shared" (default): the one note both people can edit.
    // scope "personal": the logged-in person's own note. The author is always taken from the
    // session token, never from the request, so nobody can edit someone else's personal note.
    const note = String(body.note ?? "").trim().slice(0, 500);
    const now = new Date().toISOString();

    if (body.scope === "personal") {
      const { error } = note
        ? await supabase.from("vault_personal_notes")
          .upsert({ item_id: id, author: who, note, updated_at: now })
        : await supabase.from("vault_personal_notes").delete().eq("item_id", id).eq("author", who);
      return error ? json({ error: error.message }, 500) : json({ ok: true, author: who, updated_at: now });
    }

    const { error } = await supabase.from("vault_items")
      .update({ note: note || null, note_by: note ? who : null, note_updated_at: note ? now : null })
      .eq("id", id);
    return error ? json({ error: error.message }, 500) : json({ ok: true, note_by: who, updated_at: now });
  }

  if (action === "remove") {
    const { data } = await supabase.from("vault_items").select("storage_path").eq("id", id).single();
    if (data?.storage_path) await supabase.storage.from(BUCKET).remove([data.storage_path]);
    const { error } = await supabase.from("vault_items").delete().eq("id", id);
    return error ? json({ error: error.message }, 500) : json({ ok: true });
  }

  return json({ error: "unknown action" }, 400);
});
