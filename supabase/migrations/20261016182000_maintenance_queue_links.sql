-- Also queue links that were saved without a preview (no title or picture): the maintain job
-- looks up their title + cover once (oEmbed for Spotify/SoundCloud/etc, otherwise the page's og: tags).
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
    union
    select id, created_at from public.vault_items
    where kind = 'link' and enriched_at is null and (title is null or thumbnail_url is null)
      and url !~* '^https://(cdn\.discordapp\.com|media\.discordapp\.net)/'
  )
  select json_build_object(
    'ids', coalesce((select json_agg(id) from (select id from todo order by created_at desc limit max_items) t), '[]'::json),
    'total', (select count(*) from todo)
  );
$$;

revoke all on function public.vault_maintenance_queue(int, boolean) from public, anon, authenticated;
grant execute on function public.vault_maintenance_queue(int, boolean) to service_role;
