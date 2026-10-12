-- Peak Vault: everything saved from Discord, plus ratings.
-- All tables have RLS enabled and NO policies: the anon/public key can't read
-- or write anything. Only the edge functions (service role) touch this data.

create table if not exists public.vault_items (
  id               uuid primary key default gen_random_uuid(),
  dedup_key        text not null unique,          -- message id + attachment id / url
  kind             text not null check (kind in ('image','video','audio','file','link','youtube','text')),
  -- where it came from
  discord_message_id text not null,
  discord_channel_id text,
  author_id        text,
  author_name      text,
  posted_at        timestamptz,
  saved_by_id      text,
  saved_by_name    text,
  message_text     text,
  -- the thing itself
  url              text,                          -- links / youtube
  title            text,
  site_name        text,
  thumbnail_url    text,
  storage_path     text,                          -- files in the private 'vault' bucket
  file_name        text,
  content_type     text,
  size_bytes       bigint,
  width            int,
  height           int,
  note             text,
  created_at       timestamptz not null default now()
);

create index if not exists vault_items_created_idx on public.vault_items (created_at desc);
create index if not exists vault_items_posted_idx  on public.vault_items (posted_at desc);

create table if not exists public.vault_ratings (
  item_id    uuid not null references public.vault_items(id) on delete cascade,
  rater      text not null check (char_length(rater) between 1 and 32),
  score      smallint not null check (score between 1 and 5),
  updated_at timestamptz not null default now(),
  primary key (item_id, rater)
);

create table if not exists public.vault_login_attempts (
  id           bigint generated always as identity primary key,
  ip           text not null,
  attempted_at timestamptz not null default now()
);
create index if not exists vault_login_attempts_ip_idx on public.vault_login_attempts (ip, attempted_at desc);

alter table public.vault_items          enable row level security;
alter table public.vault_ratings        enable row level security;
alter table public.vault_login_attempts enable row level security;

revoke all on public.vault_items, public.vault_ratings, public.vault_login_attempts from anon, authenticated;

-- Private bucket for the actual files (50 MB per file = Supabase free-plan max).
insert into storage.buckets (id, name, public, file_size_limit)
values ('vault', 'vault', false, 52428800)
on conflict (id) do update set public = false;
