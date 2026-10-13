-- Bytes used in the private 'vault' bucket, for the storage meter.
-- Only the edge functions (service role) may call it.
create or replace function public.vault_storage_used()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum((metadata->>'size')::bigint), 0)::bigint
  from storage.objects
  where bucket_id = 'vault';
$$;

revoke all on function public.vault_storage_used() from public, anon, authenticated;
grant execute on function public.vault_storage_used() to service_role;
