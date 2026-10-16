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
//   react  { token, id, emoji } → { ok, on }           (toggle your emoji reaction on an item)
//   tier   { token, id, tier, pos } → { ok }           (tier list: "S".."F" or null = unranked; pos = order)
//   maintain { token }          → { processed, remaining, changed }
//                                 (background job the site calls: stores copies of expiring Discord links,
//                                  looks up YouTube channel names for music detection)
//   remove { token, id }        → { ok }               (deletes item + file)
//   import { token, channel_id, messages: [{id, timestamp, content, attachments: [url]}] }
//                               → { saved, already, problems, storage }
//                                 (bulk import from the official Discord data package; max 15 messages per call)
//
// Env (Supabase → Edge Functions → Secrets):
//   VAULT_PASSCODE    – the shared passcode. Changing it logs everyone out.
//   VAULT_NAMES       – comma-separated names to pick from, default "Sentiq,furfyl"
//   DISCORD_BOT_TOKEN – refreshes expired Discord attachment links (import + rescuing old links)

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
// Discord attachment links (these expire ~24 h after Discord hands them out). Group 3 = attachment id, 4 = file name.
const DISCORD_CDN = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\/(ephemeral-)?attachments\/\d+\/(\d+)\/([^?#]+)/i;
const isExpiringUrl = (u: unknown) => typeof u === "string" && DISCORD_CDN.test(u);

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
      const name = decodeURIComponent(hit[4]);
      plans.push({ key: `${m.id}:att:${hit[3]}`, msg: m, att: { url: raw.split("?")[0], id: hit[3], name } });
    }
    for (const u of new Set(String(m.content || "").match(URL_RE) || [])) {
      const hit = u.match(DISCORD_CDN);
      if (hit) {
        // a pasted Discord file link expires, so store the file itself (same key mreow would use)
        plans.push({ key: `${m.id}:url:${u}`, msg: m, att: { url: u.split("?")[0], id: hit[3], name: decodeURIComponent(hit[4]) } });
        continue;
      }
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

// ---------- keeping expiring Discord links + YouTube info (the "maintain" action) ----------

async function downloadToStorage(link: string, path: string, maxBytes = MAX_FILE) {
  const res = await fetch(link);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > maxBytes) { await res.body?.cancel(); throw new Error("over 50 MB"); }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error("over 50 MB");
  if ((await storageUsed()) + bytes.length > STORAGE_STOP) throw new Error("storage almost full");
  const ct = res.headers.get("content-type") || "application/octet-stream";
  const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType: ct, upsert: true });
  if (error) throw error;
  return { ct, size: bytes.length };
}

// Fresh, working link for a Discord attachment URL: refresh it with the bot token if we have one,
// otherwise try the signed copy we might still have (only works until it expires).
async function freshDiscordLink(original: string, signedFallback: string | null): Promise<string> {
  const base = original.split("?")[0];
  if (Deno.env.get("DISCORD_BOT_TOKEN")) {
    const fresh = await refreshUrls([base]);
    const link = fresh[base] || Object.values(fresh)[0];
    if (link) return link;
    throw new Error("Discord has no fresh link (file deleted?)");
  }
  for (const cand of [original, signedFallback]) {
    if (cand && /[?&]ex=([0-9a-f]+)/i.test(cand)) {
      const ex = parseInt(cand.match(/[?&]ex=([0-9a-f]+)/i)![1], 16) * 1000;
      if (ex > Date.now() + 60_000) return cand; // still valid
    }
  }
  throw new Error("needs bot token: the Discord link already expired. Add DISCORD_BOT_TOKEN in Supabase.");
}

// deno-lint-ignore no-explicit-any
async function rescueItem(it: any): Promise<boolean> {
  const update: Record<string, unknown> = {};
  try {
    // 1) the item itself is a Discord file link → store the file and turn the item into a real file
    if (isExpiringUrl(it.url) && !it.storage_path) {
      const hit = it.url.match(DISCORD_CDN)!;
      const name = decodeURIComponent(hit[4]);
      const link = await freshDiscordLink(it.url, isExpiringUrl(it.thumbnail_url) ? it.thumbnail_url : null);
      const path = `rescued/${it.id}-${safeName(name)}`;
      const { ct, size } = await downloadToStorage(link, path);
      Object.assign(update, {
        storage_path: path, file_name: name, content_type: ct, size_bytes: size, kind: kindFor(ct, name),
        rescued_from: it.url.split("?")[0], url: null, title: it.title, site_name: null,
        thumbnail_url: null,
      });
    }
    // 2) only the thumbnail points at Discord → store a copy of the thumbnail
    else if (isExpiringUrl(it.thumbnail_url) && !it.thumb_path) {
      const hit = it.thumbnail_url.match(DISCORD_CDN)!;
      const link = await freshDiscordLink(it.thumbnail_url, it.thumbnail_url);
      const path = `thumbs/${it.id}-${safeName(decodeURIComponent(hit[4]))}`;
      await downloadToStorage(link, path, 10 * 1024 * 1024);
      Object.assign(update, { thumb_path: path });
    }
    update.rescue_error = null;
    update.rescue_checked_at = new Date().toISOString();
    await supabase.from("vault_items").update(update).eq("id", it.id);
    return Object.keys(update).length > 2;
  } catch (e) {
    await supabase.from("vault_items").update({
      rescue_error: String((e as Error).message).slice(0, 300),
      rescue_checked_at: new Date().toISOString(),
    }).eq("id", it.id);
    return false;
  }
}

// deno-lint-ignore no-explicit-any
async function enrichYoutube(it: any): Promise<boolean> {
  let channel: string | null = null, title: string | null = null;
  try {
    const res = await withTimeout(fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(it.url)}`), 5000);
    if (res && res.ok) {
      const j = await res.json();
      channel = j.author_name ? String(j.author_name).slice(0, 120) : null;
      title = j.title ? String(j.title).slice(0, 300) : null;
    }
  } catch { /* video gone or private: just mark it as checked */ }
  const update: Record<string, unknown> = { enriched_at: new Date().toISOString() };
  if (channel) update.channel = channel;
  if (title && !it.title) update.title = title;
  await supabase.from("vault_items").update(update).eq("id", it.id);
  return Boolean(channel || (title && !it.title));
}

async function maintain() {
  const hasBot = Boolean(Deno.env.get("DISCORD_BOT_TOKEN"));
  const { data: q } = await supabase.rpc("vault_maintenance_queue", { max_items: 4, has_bot_token: hasBot });
  const ids: string[] = q?.ids || [];
  let changed = 0;
  if (ids.length) {
    const { data: rows } = await supabase.from("vault_items").select("*").in("id", ids);
    for (const it of rows || []) {
      const needsRescue = (isExpiringUrl(it.url) && !it.storage_path) || (isExpiringUrl(it.thumbnail_url) && !it.thumb_path);
      if (needsRescue && await rescueItem(it)) changed++;
      if (it.kind === "youtube" && !it.enriched_at && await enrichYoutube(it)) changed++;
    }
  }
  const { data: after } = await supabase.rpc("vault_maintenance_queue", { max_items: 0, has_bot_token: hasBot });
  return { processed: ids.length, remaining: after?.total ?? 0, changed };
}

const TIERS = ["S", "A", "B", "C", "F"];
// one emoji (incl. skin tones / ZWJ sequences / flags), nothing else
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{FE0F}|\u{200D}|\p{Emoji_Modifier}|\u{20E3}|[#*0-9])+$/u;

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
    const [{ data: items, error }, { data: ratings }, { data: pnotes }, { data: reacts }] = await Promise.all([
      supabase.from("vault_items").select("*").order("created_at", { ascending: false }).limit(2000),
      supabase.from("vault_ratings").select("item_id, rater, score"),
      supabase.from("vault_personal_notes").select("item_id, author, note, updated_at"),
      supabase.from("vault_reactions").select("item_id, person, emoji, created_at").order("created_at"),
    ]);
    if (error) return json({ error: error.message }, 500);

    const byItem: Record<string, Record<string, number>> = {};
    for (const r of ratings || []) (byItem[r.item_id] ||= {})[r.rater] = r.score;
    const notesByItem: Record<string, Record<string, { note: string; updated_at: string }>> = {};
    for (const n of pnotes || []) (notesByItem[n.item_id] ||= {})[n.author] = { note: n.note, updated_at: n.updated_at };

    // reactions per item: { "🔥": ["Sentiq", "furfyl"], ... } in the order they were first used
    const reactByItem: Record<string, Record<string, string[]>> = {};
    for (const r of reacts || []) ((reactByItem[r.item_id] ||= {})[r.emoji] ||= []).push(r.person);

    const paths = (items || []).flatMap((i) => [i.storage_path, i.thumb_path]).filter(Boolean) as string[];
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
        // our stored copy wins over a Discord thumbnail link that may have expired
        thumbnail_url: i.thumb_path ? urls[i.thumb_path] ?? null : (isExpiringUrl(i.thumbnail_url) ? null : i.thumbnail_url),
        ratings: byItem[i.id] || {},
        personal_notes: notesByItem[i.id] || {},
        reactions: reactByItem[i.id] || {},
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

  if (action === "maintain") {
    try { return json(await maintain()); }
    catch (e) { return json({ error: (e as Error).message }, 500); }
  }

  const id = String(body.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "bad id" }, 400);

  if (action === "react") {
    const emoji = String(body.emoji || "").trim();
    if (!emoji || emoji.length > 16 || !EMOJI_RE.test(emoji)) return json({ error: "not an emoji" }, 400);
    const { data: existing } = await supabase.from("vault_reactions").select("emoji")
      .eq("item_id", id).eq("person", who).eq("emoji", emoji).maybeSingle();
    if (existing) {
      const { error } = await supabase.from("vault_reactions").delete().eq("item_id", id).eq("person", who).eq("emoji", emoji);
      return error ? json({ error: error.message }, 500) : json({ ok: true, on: false });
    }
    const { count } = await supabase.from("vault_reactions").select("emoji", { count: "exact", head: true })
      .eq("item_id", id).eq("person", who);
    if ((count ?? 0) >= 20) return json({ error: "that's a lot of reactions already" }, 400);
    const { error } = await supabase.from("vault_reactions").insert({ item_id: id, person: who, emoji });
    return error ? json({ error: error.message }, 500) : json({ ok: true, on: true });
  }

  if (action === "tier") {
    const tier = body.tier === null || body.tier === "" ? null : String(body.tier).toUpperCase();
    if (tier !== null && !TIERS.includes(tier)) return json({ error: "tier must be S, A, B, C, F or empty" }, 400);
    const pos = Number(body.pos);
    const { error } = await supabase.from("vault_items")
      .update({ tier, tier_pos: tier === null ? null : (Number.isFinite(pos) ? pos : Date.now()) })
      .eq("id", id);
    return error ? json({ error: error.message }, 500) : json({ ok: true });
  }

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
    const { data } = await supabase.from("vault_items").select("storage_path, thumb_path").eq("id", id).single();
    const files = [data?.storage_path, data?.thumb_path].filter(Boolean) as string[];
    if (files.length) await supabase.storage.from(BUCKET).remove(files);
    const { error } = await supabase.from("vault_items").delete().eq("id", id);
    return error ? json({ error: error.message }, 500) : json({ ok: true });
  }

  return json({ error: "unknown action" }, 400);
});
