-- Private server-side settings (only the edge functions can read them; RLS on, no policies).
-- Used for keys that are easier to set here than as Edge Function secrets, e.g. youtube_api_key.
-- Values are inserted directly in the database, never committed to the repo.
create table if not exists public.vault_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);
alter table public.vault_settings enable row level security;
revoke all on public.vault_settings from anon, authenticated;
