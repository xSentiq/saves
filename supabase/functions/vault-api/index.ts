// Peak Vault API – the only door into the vault data.
//
// POST JSON { action, ... }
//   config                      → { names }            (who can log in)
//   login  { passcode, name }   → { token, name }      (token valid 30 days)
//   list   { token }            → { items }            (files come with 6 h signed URLs)
//   rate   { token, id, score } → { ok }               (score 1–5, or 0 to clear)
//   note   { token, id, note, scope? } → { ok }        (scope "shared" = note both can edit,
//                                                      "personal" = your own note, read-only for others)
//   tags   { token, id, tags }  → { ok, tags }         (replace the item's tags, max 12, lowercase)
//   remove { token, id }        → { ok }               (deletes item + file)
//   import { token, channel_id, messages: [{id, timestamp, content, attachments: [url]}] }
//                               → { saved, already, problems, storage }
//                                 (bulk import from the official Discord data package; max 15 messages per call)
//
// Env (Supabase → Edge Functions → Secrets):
//   VAULT_PASSCODE    – the shared passcode. Changing it logs everyone out.
//   VAULT_NAMES       – comma-separated names to pick from, default "Sentiq,furfyl"
//   DISCORD_BOT_TOKEN – only for import: refreshes expired Discord attachment links

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const BUCKET = "vault";
const STORAGE_LIMIT = 1024 ** 3;            // Supabase free plan: 1 GB
const STORAGE_STOP = STORAGE_LIMIT * 0.95;  // import stops storing files above this
const MAX_FILE = 50 * 1024 * 1024;          // free plan per-file limit
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

async function storageUsed(): Promise<number> {
  const { data } = await supabase.rpc("vault_storage_used");
  return Number(data ?? 0);
}

// ---------- bulk import helpers (same rules as mreow's "Save to Vault") ----------

const URL_RE = /https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?\]]/gi;
const DISCORD_CDN = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/\d+\/(\d+)\/([^?#]+)/;

function youtubeId(u: string): string | null {
  try {
    const url = new URL(u);
    const h = url.hostname.replace(/^www\.|^m\./, "");
    if (h === "youtu.be") return url.pathname.slice(1).split("/")[0] || null;
    if (h === "youtube.com" || h === "music.youtube.com") {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      const m = url.pathname.match(/^\/(shorts|embed|live)\/([\w-]{6,})/);
      if (m) return m[2];
    }
  } catch { /* not a url */ }
  return null;
}

function kindFor(contentType: string | null, name: string): string {
  const ct = (contentType || "").toLowerCase();
  if (ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(name)) return "image";
  if (ct.startsWith("video/") || /\.(mp4|webm|mov|mkv)$/i.test(name)) return "video";
  if (ct.startsWith("audio/") || /\.(mp3|ogg|wav|flac|m4a|opus)$/i.test(name)) return "audio";
  return "file";
}

const safeName = (n: string) => n.replace(/[^\w.\-]+/g, "_").slice(-120) || "file";

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return await Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

async function youtubeTitle(u: string): Promise<string | null> {
  try {
    const res = await withTimeout(fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u)}`), 4000);
    if (!res || !res.ok) return null;
    const j = await res.json();
    return j.title ? `${j.title}` : null;
  } catch { return null; }
}

// Discord attachment links in the data package have expired; a bot can get fresh ones.
async function refreshUrls(urls: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const bot = Deno.env.get("DISCORD_BOT_TOKEN");
  for (let k = 0; k < urls.length; k += 50) {
    const res = await fetch("https://discord.com/api/v10/attachments/refresh-urls", {
      method: "POST",
      headers: { Authorization: `Bot ${bot}`, "Content-Type": "application/json" },
      body: JSON.stringify({ attachment_urls: urls.slice(k, k + 50) }),
    });
    if (!res.ok) throw new Error(`Discord refused to refresh links (${res.status}). Is DISCORD_BOT_TOKEN right?`);
    const j = await res.json();
    for (const r of j.refreshed_urls || []) out[r.original] = r.refreshed;
  }
  return out;
}

type ImportMsg = { id: string; timestamp?: string; content?: string; attachments?: string[] };

async function importBatch(who: string, channelId: string, msgs: ImportMsg[]) {
  const problems: string[] = [];
  const rows: Record<string, unknown>[] = [];
  let used = await storageUsed();

  // plan every item first, then skip the ones already in the vault before doing any downloads
  type Plan = { key: string; msg: ImportMsg; att?: { url: string; id: string; name: string }; url?: string };
  const plans: Plan[] = [];
  for (const m of msgs) {
    if (!/^\d{5,25}$/.test(String(m.id))) continue;
    for (const raw of m.attachments || []) {
      const hit = String(raw).match(DISCORD_CDN);
      if (!hit) continue;
      const name = decodeURIComponent(hit[3]);
      plans.push({ key: `${m.id}:att:${hit[2]}`, msg: m, att: { url: raw.split("?")[0], id: hit[2], name } });
    }
    for (const u of new Set(String(m.content || "").match(URL_RE) || [])) {
      if (DISCORD_CDN.test(u)) continue; // pasted attachment links are handled as attachments above
      plans.push({ key: `${m.id}:url:${u}`, msg: m, url: u });
    }
  }
  if (!plans.length) return { saved: 0, already: 0, problems, storage: used };

  const { data: existing } = await supabase.from("vault_items").select("dedup_key").in("dedup_key", plans.map((p) => p.key));
  const have = new Set((existing || []).map((r) => r.dedup_key));
  const todo = plans.filter((p) => !have.has(p.key));

  const fresh = await refreshUrls(todo.filter((p) => p.att).map((p) => p.att!.url));

  for (const p of todo) {
    const base = {
      dedup_key: p.key,
      discord_message_id: String(p.msg.id),
      discord_channel_id: channelId || null,
      author_name: who,
      posted_at: p.msg.timestamp ? new Date(p.msg.timestamp).toISOString() : null,
      saved_by_name: who,
      message_text: (p.msg.content || "").trim() || null,
    };

    if (p.url) {
      const yt = youtubeId(p.url);
      let host = "";
      try { host = new URL(p.url).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
      rows.push({
        ...base,
        kind: yt ? "youtube" : "link",
        url: p.url,
        title: yt ? await youtubeTitle(p.url) : null,
        site_name: yt ? "YouTube" : host || null,
        thumbnail_url: yt ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` : null,
      });
      continue;
    }

    const a = p.att!;
    const row: Record<string, unknown> = { ...base, file_name: a.name, kind: kindFor(null, a.name) };
    const link = fresh[a.url] || fresh[a.url + "?"] || null;
    try {
      if (!link) throw new Error("Discord has no fresh link (file deleted?)");
      if (used > STORAGE_STOP) throw new Error("storage almost full");
      const res = await fetch(link);
      if (!res.ok) throw new Error(`download ${res.status}`);
      const len = Number(res.headers.get("content-length") || 0);
      if (len > MAX_FILE) { await res.body?.cancel(); throw new Error("over 50 MB"); }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_FILE) throw new Error("over 50 MB");
      if (used + bytes.length > STORAGE_STOP) throw new Error("storage almost full");
      const ct = res.headers.get("content-type");
      const path = `import/${p.msg.id}-${a.id}-${safeName(a.name)}`;
      const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
        contentType: ct || "application/octet-stream", upsert: true,
      });
      if (error) throw error;
      used += bytes.length;
      Object.assign(row, { storage_path: path, content_type: ct, size_bytes: bytes.length, kind: kindFor(ct, a.name) });
    } catch (e) {
      const msg = (e as Error).message;
      row.note = `Not stored: ${msg}. Only the info was saved.`;
      problems.push(`${a.name}: ${msg}`);
    }
    rows.push(row);
  }

  let saved = 0;
  if (rows.length) {
    const { data, error } = await supabase.from("vault_items")
      .upsert(rows, { onConflict: "dedup_key", ignoreDuplicates: true }).select("id");
    if (error) throw error;
    saved = data?.length ?? 0;
  }
  return { saved, already: plans.length - todo.length, problems, storage: used };
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
      storage: { used: await storageUsed(), limit: STORAGE_LIMIT },
      items: (items || []).map((i) => ({
        ...i,
        file_url: i.storage_path ? urls[i.storage_path] ?? null : null,
        ratings: byItem[i.id] || {},
        personal_notes: notesByItem[i.id] || {},
      })),
    });
  }

  if (action === "import") {
    if (!Deno.env.get("DISCORD_BOT_TOKEN")) {
      return json({ error: "Import needs the DISCORD_BOT_TOKEN secret in Supabase (it refreshes old Discord file links)." }, 503);
    }
    const msgs = Array.isArray(body.messages) ? (body.messages as ImportMsg[]).slice(0, 15) : [];
    const channelId = /^\d{5,25}$/.test(String(body.channel_id || "")) ? String(body.channel_id) : "";
    try {
      return json(await importBatch(who, channelId, msgs));
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }
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

  if (action === "tags") {
    // replaces the item's tag list; both people can edit tags
    const raw = Array.isArray(body.tags) ? body.tags : [];
    const tags = [...new Set(raw
      .map((t) => String(t).toLowerCase().trim().replace(/^#+/, "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 24))
      .filter(Boolean))].slice(0, 12);
    const { error } = await supabase.from("vault_items").update({ tags }).eq("id", id);
    return error ? json({ error: error.message }, 500) : json({ ok: true, tags });
  }

  if (action === "remove") {
    const { data } = await supabase.from("vault_items").select("storage_path").eq("id", id).single();
    if (data?.storage_path) await supabase.storage.from(BUCKET).remove([data.storage_path]);
    const { error } = await supabase.from("vault_items").delete().eq("id", id);
    return error ? json({ error: error.message }, 500) : json({ ok: true });
  }

  return json({ error: "unknown action" }, 400);
});
