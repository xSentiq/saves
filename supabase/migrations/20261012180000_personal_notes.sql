-- Notes: vault_items.note stays the shared note (anyone can edit).
-- Each person also gets their own note per item: everyone can read it, only its author can edit it
-- (enforced in the vault-api function, which knows who is logged in).

create table if not exists public.vault_personal_notes (
  item_id    uuid not null references public.vault_items(id) on delete cascade,
  author     text not null check (char_length(author) between 1 and 32),
  note       text not null check (char_length(note) between 1 and 500),
  updated_at timestamptz not null default now(),
  primary key (item_id, author)
);

alter table public.vault_personal_notes enable row level security;
revoke all on public.vault_personal_notes from anon, authenticated;

-- Who last edited the shared note, and when.
alter table public.vault_items add column if not exists note_by text;
alter table public.vault_items add column if not exists note_updated_at timestamptz;
