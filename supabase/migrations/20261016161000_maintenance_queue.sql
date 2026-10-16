-- Items the vault-api "maintain" action still has to work on:
--   1. Discord CDN links/thumbnails (they expire) that don't have our own stored copy yet
--   2. YouTube items whose channel name hasn't been looked up yet (for music detection)
-- Failed rescues are retried at most once a day, except failures caused by a missing bot token
-- are retried right away once the token exists (has_bot_token = true).
create or replace function public.vault_maintenance_queue(max_items int, has_bot_token boolean)
returns json
language sql
stable
security definer
set search_path = ''
as $$
  with todo as (
    select id, created_at from public.vault_items
    where (
        (url ~* '^https://(cdn\.discordapp\.com|media\.discordapp\.net)/(ephemeral-)?attachments/' and storage_path is null)
        or (thumbnail_url ~* '^https://(cdn\.discordapp\.com|media\.discordapp\.net)/(ephemeral-)?attachments/' and thumb_path is null)
      )
      and (
        rescue_checked_at is null
        or rescue_checked_at < now() - interval '1 day'
        or (has_bot_token and rescue_error like 'needs bot token%')
      )
    union
    select id, created_at from public.vault_items where kind = 'youtube' and enriched_at is null
  )
  select json_build_object(
    'ids', coalesce((select json_agg(id) from (select id from todo order by created_at limit max_items) t), '[]'::json),
    'total', (select count(*) from todo)
  );
$$;

revoke all on function public.vault_maintenance_queue(int, boolean) from public, anon, authenticated;
grant execute on function public.vault_maintenance_queue(int, boolean) to service_role;
