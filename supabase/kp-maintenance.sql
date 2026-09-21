-- Apply on each metadata object host. SQL only lists objects: deletions MUST
-- go through the Storage API so the underlying file is actually removed.
create or replace function public.kp_object_page(p_after text default '', p_limit integer default 500)
returns table(name text)
language sql security definer set search_path = public, storage as $$
  select o.name from storage.objects o
  where o.bucket_id = 'kp' and o.name like 'v2/%' and o.name > p_after
  order by o.name limit greatest(1, least(p_limit, 1000))
$$;
revoke all on function public.kp_object_page(text, integer) from public, anon, authenticated;
grant execute on function public.kp_object_page(text, integer) to service_role;
