-- Spotify links play through a matching YouTube video instead of Spotify's player.
--   yt_match            = YouTube video id that plays for this item
--   yt_match_title      = that video's title (shown on the card)
--   yt_match_manual     = true when one of you picked the video by hand (never overwritten)
--   yt_match_checked_at = last automatic search (failed searches retry after a week)
alter table public.vault_items add column if not exists yt_match text;
alter table public.vault_items add column if not exists yt_match_title text;
alter table public.vault_items add column if not exists yt_match_manual boolean not null default false;
alter table public.vault_items add column if not exists yt_match_checked_at timestamptz;

-- Spotify tracks that still need a YouTube match (used by the vault-api "maintain" job).
create or replace function public.vault_youtube_match_queue(max_items int)
returns json
language sql
stable
security definer
set search_path = ''
as $$
  with todo as (
    select id, created_at from public.vault_items
    where kind = 'link' and yt_match is null and not yt_match_manual
      and url ~* '^https://open\.spotify\.com/(intl-[a-z-]+/)?track/'
      and (yt_match_checked_at is null or yt_match_checked_at < now() - interval '7 days')
  )
  select json_build_object(
    'ids', coalesce((select json_agg(id) from (select id from todo order by created_at desc limit max_items) t), '[]'::json),
    'total', (select count(*) from todo)
  );
$$;

revoke all on function public.vault_youtube_match_queue(int) from public, anon, authenticated;
grant execute on function public.vault_youtube_match_queue(int) to service_role;
