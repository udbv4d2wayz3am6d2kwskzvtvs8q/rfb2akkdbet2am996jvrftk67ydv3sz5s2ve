-- Shared Zona identity cache. The public object is the hot path; this row is
-- touched only when the current immutable Storage slot is absent. The lease
-- collapses a mass miss to one mzona resolve across Edge isolates.
create table if not exists public.zona_resolve_state (
  kp_id bigint primary key check (kp_id > 0),
  status text not null default 'pending' check (status in ('pending', 'ok')),
  fresh_until timestamptz,
  retry_at timestamptz,
  version integer not null default 0,
  lease_owner text,
  lease_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.zona_resolve_state enable row level security;
revoke all on public.zona_resolve_state from public, anon, authenticated;

create or replace function public.zona_acquire(
  p_id bigint, p_owner text, p_lease_seconds integer
)
returns table (
  acquired boolean, version integer, status text,
  fresh_until timestamptz, retry_at timestamptz
)
language plpgsql security definer set search_path = public as $fn$
#variable_conflict use_column
declare rec public.zona_resolve_state;
begin
  if p_id <= 0 or p_owner = '' then raise exception 'bad request'; end if;
  insert into public.zona_resolve_state(kp_id) values (p_id) on conflict do nothing;
  select * into rec from public.zona_resolve_state where kp_id = p_id for update;

  if rec.status = 'ok' and rec.fresh_until > now() then
    return query select false, rec.version, rec.status, rec.fresh_until, rec.retry_at;
    return;
  end if;
  if rec.retry_at > now() or (rec.lease_until > now() and rec.lease_owner <> p_owner) then
    return query select false, rec.version, rec.status, rec.fresh_until, rec.retry_at;
    return;
  end if;

  update public.zona_resolve_state set
    status = 'pending', version = rec.version + 1,
    lease_owner = p_owner,
    lease_until = now() + make_interval(secs => greatest(5, least(p_lease_seconds, 60))),
    retry_at = null, updated_at = now()
  where kp_id = p_id
  returning zona_resolve_state.version into rec.version;
  return query select true, rec.version, 'pending'::text, null::timestamptz, null::timestamptz;
end;
$fn$;

create or replace function public.zona_complete(
  p_id bigint, p_owner text, p_version integer, p_fresh_until timestamptz
)
returns boolean language plpgsql security definer set search_path = public as $fn$
begin
  update public.zona_resolve_state set
    status = 'ok', fresh_until = p_fresh_until, retry_at = null,
    lease_owner = null, lease_until = null, updated_at = now()
  where kp_id = p_id and lease_owner = p_owner and version = p_version;
  return found;
end;
$fn$;

create or replace function public.zona_fail(
  p_id bigint, p_owner text, p_version integer, p_retry_at timestamptz
)
returns boolean language plpgsql security definer set search_path = public as $fn$
begin
  update public.zona_resolve_state set
    status = 'pending', retry_at = p_retry_at,
    lease_owner = null, lease_until = null, updated_at = now()
  where kp_id = p_id and lease_owner = p_owner and version = p_version;
  return found;
end;
$fn$;

revoke all on function public.zona_acquire(bigint,text,integer) from public, anon, authenticated;
revoke all on function public.zona_complete(bigint,text,integer,timestamptz) from public, anon, authenticated;
revoke all on function public.zona_fail(bigint,text,integer,timestamptz) from public, anon, authenticated;
grant execute on function public.zona_acquire(bigint,text,integer) to service_role;
grant execute on function public.zona_complete(bigint,text,integer,timestamptz) to service_role;
grant execute on function public.zona_fail(bigint,text,integer,timestamptz) to service_role;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('zona', 'zona', true, 16384, array['application/json'])
on conflict (id) do update set
  public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
