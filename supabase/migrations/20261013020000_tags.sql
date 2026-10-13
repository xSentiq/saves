-- Tags on vault items (lowercase, deduped by the API). Both people can edit them.
alter table public.vault_items add column if not exists tags text[] not null default '{}';
create index if not exists vault_items_tags_idx on public.vault_items using gin (tags);
