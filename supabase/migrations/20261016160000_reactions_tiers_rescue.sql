-- Reactions: each person can put any number of emoji on an item (toggle on/off).
create table if not exists public.vault_reactions (
  item_id    uuid not null references public.vault_items(id) on delete cascade,
  person     text not null check (char_length(person) between 1 and 32),
  emoji      text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (item_id, person, emoji)
);
alter table public.vault_reactions enable row level security;
revoke all on public.vault_reactions from anon, authenticated;

-- Tier list (shared between both people): tier S/A/B/C/F or null = unranked, pos = order inside the tier.
alter table public.vault_items add column if not exists tier text check (tier in ('S','A','B','C','F'));
alter table public.vault_items add column if not exists tier_pos double precision;

-- Keeping expiring Discord CDN links:
--   thumb_path        = our own stored copy of a thumbnail that pointed at Discord's CDN
--   rescued_from      = the original Discord link a stored file was rescued from
--   rescue_checked_at = last rescue attempt (so failures are retried at most once a day)
--   rescue_error      = why the last attempt failed
alter table public.vault_items add column if not exists thumb_path text;
alter table public.vault_items add column if not exists rescued_from text;
alter table public.vault_items add column if not exists rescue_checked_at timestamptz;
alter table public.vault_items add column if not exists rescue_error text;

-- YouTube channel name (helps the music player tell songs from other videos; "Artist - Topic" = music).
alter table public.vault_items add column if not exists channel text;
alter table public.vault_items add column if not exists enriched_at timestamptz;
