create table if not exists public.alphy_documents (
  name text primary key check (name in ('catalog', 'key_pool')),
  revision integer not null check (revision >= 0),
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  check (octet_length(payload::text) <= 600000)
);
alter table public.alphy_documents enable row level security;
revoke all on public.alphy_documents from anon, authenticated;

create or replace function public.alphy_document_read(p_name text)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('revision', revision, 'payload', payload) from alphy_documents where name = p_name
$$;
create or replace function public.alphy_document_write(p_name text, p_payload jsonb, p_expected integer, p_revision integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare current_doc public.alphy_documents;
begin
  perform pg_advisory_xact_lock(hashtextextended('alphy-doc:' || p_name, 0));
  select * into current_doc from alphy_documents where name = p_name;
  if coalesce(current_doc.revision, 0) <> p_expected or p_revision < p_expected then
    return jsonb_build_object('written', false, 'current', current_doc.payload);
  end if;
  insert into alphy_documents(name, revision, payload) values (p_name, p_revision, p_payload)
  on conflict(name) do update set revision = excluded.revision, payload = excluded.payload, updated_at = now();
  return jsonb_build_object('written', true, 'revision', p_revision);
end $$;
revoke all on function public.alphy_document_read(text) from public, anon, authenticated;
revoke all on function public.alphy_document_write(text, jsonb, integer, integer) from public, anon, authenticated;
grant execute on function public.alphy_document_read(text) to service_role;
grant execute on function public.alphy_document_write(text, jsonb, integer, integer) to service_role;
