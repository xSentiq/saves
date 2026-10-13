// mreow – the Discord app behind Peak Vault (interactions endpoint).
//
// Handles:
//   • "Save to Vault"  – message context-menu command (right-click a message → Apps).
//                        Works in DMs because the app is *user-installed*.
//   • /vault link      – replies with the website link (only you see it).
//   • /vault random    – posts a random saved thing for both of you (optional type filter).
//
// Discord gives us the full target message in the interaction payload, so we never
// read any chat on our own: only the message you explicitly click gets saved.
//
// Env (Supabase → Edge Functions → Secrets):
//   DISCORD_PUBLIC_KEY        – from the Discord Developer Portal (General Information)
//   ALLOWED_DISCORD_USER_IDS  – comma-separated Discord user IDs allowed to save
//   VAULT_SITE_URL            – optional, link shown by /vault (default: https://vault.faggot.world/)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.

import { createClient } from "npm:@supabase/supabase-js@2";
import nacl from "npm:tweetnacl@1.0.3";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const MAX_BYTES = 50 * 1024 * 1024; // Supabase free plan per-file limit
const BUCKET = "vault";
const SITE_URL = Deno.env.get("VAULT_SITE_URL") || "https://vault.faggot.world/";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function verify(body: string, sig: string | null, ts: string | null): boolean {
  const key = Deno.env.get("DISCORD_PUBLIC_KEY");
  if (!key || !sig || !ts || !/^[0-9a-f]+$/i.test(sig)) return false;
  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(ts + body),
      hexToBytes(sig),
      hexToBytes(key),
    );
  } catch {
    return false;
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const EPHEMERAL = 64;

// ---------- extracting things from a message ----------

type Item = Record<string, unknown> & { dedup_key: string; kind: string };

const URL_RE = /https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?\]]/gi;

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

function kindFor(contentType: string | undefined, name: string): string {
  const ct = (contentType || "").toLowerCase();
  if (ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(name)) return "image";
  if (ct.startsWith("video/") || /\.(mp4|webm|mov|mkv)$/i.test(name)) return "video";
  if (ct.startsWith("audio/") || /\.(mp3|ogg|wav|flac|m4a|opus)$/i.test(name)) return "audio";
  return "file";
}

function safeName(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(-120) || "file";
}

// deno-lint-ignore no-explicit-any
async function saveMessage(msg: any, savedBy: { id: string; name: string }, channelId: string) {
  // Forwarded messages keep their content in message_snapshots.
  const snap = msg.message_snapshots?.[0]?.message;
  const content: string = (msg.content || snap?.content || "").trim();
  // deno-lint-ignore no-explicit-any
  const attachments: any[] = [...(msg.attachments || []), ...(snap?.attachments || [])];
  // deno-lint-ignore no-explicit-any
  const embeds: any[] = [...(msg.embeds || []), ...(snap?.embeds || [])];

  const base = {
    discord_message_id: msg.id,
    discord_channel_id: channelId,
    author_id: msg.author?.id ?? null,
    author_name: msg.author?.global_name || msg.author?.username || null,
    posted_at: msg.timestamp ?? null,
    saved_by_id: savedBy.id,
    saved_by_name: savedBy.name,
    message_text: content || null,
  };

  const items: Item[] = [];
  const problems: string[] = [];

  // 1) attachments → download from Discord, upload into the private bucket
  for (const a of attachments) {
    const name: string = a.filename || "file";
    const kind = kindFor(a.content_type, name);
    const item: Item = {
      ...base,
      dedup_key: `${msg.id}:att:${a.id}`,
      kind,
      file_name: name,
      content_type: a.content_type ?? null,
      size_bytes: a.size ?? null,
      width: a.width ?? null,
      height: a.height ?? null,
    };
    if ((a.size ?? 0) > MAX_BYTES) {
      item.note = "Too big to store (over 50 MB), only the info was saved.";
      problems.push(`${name} is over 50 MB`);
      items.push(item);
      continue;
    }
    try {
      const res = await fetch(a.url);
      if (!res.ok) throw new Error(`download ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const path = `${new Date().toISOString().slice(0, 7)}/${msg.id}-${a.id}-${safeName(name)}`;
      const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
        contentType: a.content_type || "application/octet-stream",
        upsert: true,
      });
      if (error) throw error;
      item.storage_path = path;
    } catch (e) {
      item.note = "Couldn't download the file from Discord.";
      problems.push(`${name}: ${(e as Error).message}`);
    }
    items.push(item);
  }

  // 2) links (YouTube gets its own kind). Use Discord's embed for title/thumbnail.
  const urls = [...new Set(content.match(URL_RE) || [])];
  for (const u of urls) {
    const embed = embeds.find((e) => e.url && (e.url === u || u.startsWith(e.url) || e.url.startsWith(u)));
    const yt = youtubeId(u);
    let host = "";
    try { host = new URL(u).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
    items.push({
      ...base,
      dedup_key: `${msg.id}:url:${u}`,
      kind: yt ? "youtube" : "link",
      url: u,
      title: embed?.title ?? null,
      site_name: embed?.provider?.name || embed?.author?.name || host || null,
      thumbnail_url: yt
        ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`
        : (embed?.thumbnail?.url || embed?.image?.url || null),
    });
  }

  // 3) nothing else? keep the text itself (a good quote is worth saving too)
  if (items.length === 0 && content) {
    items.push({ ...base, dedup_key: `${msg.id}:text`, kind: "text" });
  }

  if (items.length === 0) return { saved: 0, already: 0, problems: ["Nothing to save in that message."] };

  const { data, error } = await supabase
    .from("vault_items")
    .upsert(items, { onConflict: "dedup_key", ignoreDuplicates: true })
    .select("id");
  if (error) return { saved: 0, already: 0, problems: [error.message] };
  const saved = data?.length ?? 0;
  return { saved, already: items.length - saved, problems };
}

// ---------- /vault random ----------

const KIND_LABEL: Record<string, string> = {
  image: "an image", video: "a video", youtube: "a YouTube video", link: "a link",
  audio: "some audio", file: "a file", text: "a quote",
};

async function randomPost(kind: string): Promise<string> {
  let q = supabase.from("vault_items").select("id", { count: "exact", head: true });
  if (kind !== "any") q = q.eq("kind", kind);
  const { count } = await q;
  if (!count) return kind === "any" ? "🐱 the vault is empty… save something first!" : `🐱 no ${kind} in the vault yet.`;

  let pick = supabase.from("vault_items").select("*").order("created_at", { ascending: true });
  if (kind !== "any") pick = pick.eq("kind", kind);
  const off = Math.floor(Math.random() * count);
  const { data: rows } = await pick.range(off, off);
  const it = rows?.[0];
  if (!it) return "🐱 mrrp? couldn't pick one, try again.";

  const [{ data: ratings }, { data: pnotes }] = await Promise.all([
    supabase.from("vault_ratings").select("rater, score").eq("item_id", it.id),
    supabase.from("vault_personal_notes").select("author, note").eq("item_id", it.id),
  ]);

  let link = it.url as string | null;
  if (!link && it.storage_path) {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(it.storage_path, 7 * 24 * 3600);
    link = data?.signedUrl ?? null;
  }

  const when = it.posted_at || it.created_at;
  const date = when ? new Date(when).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
  const stars = (ratings || []).map((r) => `${r.rater} ${"★".repeat(r.score)}${"☆".repeat(5 - r.score)}`).join(" · ");
  const lines = [
    `🎲 **from the vault**: ${KIND_LABEL[it.kind] || "something"}${it.author_name ? ` from **${it.author_name}**` : ""}${date ? ` (${date})` : ""}`,
  ];
  if (it.title) lines.push(`**${String(it.title).slice(0, 200)}**`);
  if (it.kind === "text" && it.message_text) lines.push(`> ${String(it.message_text).slice(0, 600).replace(/\n/g, "\n> ")}`);
  lines.push(stars ? stars : "nobody rated this yet 👀");
  if (it.note) lines.push(`📝 ${String(it.note).slice(0, 300)}`);
  for (const n of pnotes || []) lines.push(`💬 ${n.author}: ${String(n.note).slice(0, 200)}`);
  if (!link && it.kind !== "text") lines.push("_(file wasn't stored, only the info)_");
  // masked link: shows as a short "link" but Discord still previews it underneath
  const tail = link ? `\n[link](${link})` : "";
  return lines.join("\n").slice(0, 1990 - tail.length) + tail;
}

// deno-lint-ignore no-explicit-any
async function editReply(i: any, content: string) {
  await fetch(
    `https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) },
  );
}

// ---------- server ----------

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Peak Vault Discord endpoint", { status: 200 });

  const body = await req.text();
  if (!verify(body, req.headers.get("x-signature-ed25519"), req.headers.get("x-signature-timestamp"))) {
    return new Response("invalid request signature", { status: 401 });
  }

  const i = JSON.parse(body);
  if (i.type === 1) return json({ type: 1 }); // PING

  if (i.type !== 2) return json({ type: 4, data: { content: "Unsupported.", flags: EPHEMERAL } });

  const user = i.member?.user || i.user || {};
  const allowed = (Deno.env.get("ALLOWED_DISCORD_USER_IDS") || "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  if (!allowed.includes(user.id)) {
    return json({
      type: 4,
      data: {
        flags: EPHEMERAL,
        content: `🔒 mreow doesn't know you. Your Discord ID is \`${user.id}\`. ` +
          `Add it to ALLOWED_DISCORD_USER_IDS to let you save.`,
      },
    });
  }

  const cmd = i.data?.name;

  if (cmd === "vault") {
    const sub = i.data?.options?.[0];
    if (sub?.name === "random") {
      // deno-lint-ignore no-explicit-any
      const kind = sub.options?.find((o: any) => o.name === "type")?.value || "any";
      EdgeRuntime.waitUntil((async () => {
        try { await editReply(i, await randomPost(kind)); }
        catch (e) { await editReply(i, `🙀 something broke: ${(e as Error).message}`); }
      })());
      return json({ type: 5 }); // not ephemeral: the random pick is posted for both of you
    }
    // "/vault link" (and the old plain "/vault")
    return json({ type: 4, data: { flags: EPHEMERAL, content: `🐱 mrrp! [open the vault](${SITE_URL})` } });
  }

  if (cmd === "Save to Vault" && i.data?.type === 3) {
    const msg = i.data.resolved?.messages?.[i.data.target_id];
    if (!msg) return json({ type: 4, data: { flags: EPHEMERAL, content: "Couldn't read that message." } });

    const savedBy = { id: user.id, name: user.global_name || user.username || "someone" };
    const channelId = i.channel_id || i.channel?.id || "";

    // Downloads can take longer than Discord's 3 s limit: answer "thinking…" now, finish in background.
    EdgeRuntime.waitUntil((async () => {
      try {
        const r = await saveMessage(msg, savedBy, channelId);
        let text = r.saved > 0
          ? `🐱 mreow! saved ${r.saved} thing${r.saved === 1 ? "" : "s"} to the vault.`
          : r.already > 0 ? "🐱 mrrp? that's already in the vault." : "🐱 …nothing to save in that one.";
        if (r.already > 0 && r.saved > 0) text += ` (${r.already} already there)`;
        if (r.problems.length) text += `\n⚠️ ${r.problems.join("\n⚠️ ")}`;
        await editReply(i, text);
      } catch (e) {
        await editReply(i, `🙀 something broke: ${(e as Error).message}`);
      }
    })());

    return json({ type: 5, data: { flags: EPHEMERAL } });
  }

  return json({ type: 4, data: { flags: EPHEMERAL, content: "Unknown command." } });
});
