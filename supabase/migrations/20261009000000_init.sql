-- CompassIQ cloud — Phase 1: companies, territories, people, doctor data.
--
-- Access model
--   organizations   one per client company; status 'active' | 'suspended'
--   members         one row per person (one company each); role owner | admin | manager | rep;
--                   status 'active' | 'disabled'
--   member_territories  which territories a manager or rep works (a rep normally has one)
--   hcps            the doctor list, one row per doctor per territory; `data` is the app's HCP object
--   platform_admins the CompassIQ team (you): create companies, suspend / reactivate them
--
-- Every read goes through row level security. Nothing is visible unless the person is an
-- active member of an active company; owners and admins see their whole company, managers
-- and reps only their territories. Writes go through the SECURITY DEFINER functions below,
-- which check the caller's role themselves.


create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 200),
  status      text not null default 'active' check (status in ('active', 'suspended')),
  created_at  timestamptz not null default now()
);

create table public.territories (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 200),
  created_at  timestamptz not null default now(),
  unique (org_id, name)
);

create table public.members (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  role        text not null check (role in ('owner', 'admin', 'manager', 'rep')),
  status      text not null default 'active' check (status in ('active', 'disabled')),
  email       text not null,
  full_name   text not null default '',
  created_at  timestamptz not null default now()
);
create index members_org_idx on public.members (org_id);

create table public.member_territories (
  user_id       uuid not null references public.members(user_id) on delete cascade,
  territory_id  uuid not null references public.territories(id) on delete cascade,
  primary key (user_id, territory_id)
);
create index member_territories_territory_idx on public.member_territories (territory_id);

create table public.publishes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  created_by  uuid references auth.users(id) on delete set null,
  status      text not null default 'open' check (status in ('open', 'done', 'abandoned')),
  hcp_count   integer not null default 0,
  territory_count integer not null default 0,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index publishes_org_idx on public.publishes (org_id, created_at desc);

create table public.hcps (
  id            bigint generated always as identity primary key,
  org_id        uuid not null references public.organizations(id) on delete cascade,
  territory_id  uuid not null references public.territories(id) on delete cascade,
  publish_id    uuid not null references public.publishes(id) on delete cascade,
  npi           text,
  data          jsonb not null,
  live          boolean not null default false,   -- false until its publish finishes
  updated_at    timestamptz not null default now()
);
create index hcps_territory_idx on public.hcps (territory_id);
create index hcps_org_publish_idx on public.hcps (org_id, publish_id);

create table public.platform_admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- ── Who is calling ─────────────────────────────────────────────────────────
-- Active membership of an active company, or nothing.
create or replace function public.ciq_me()
returns public.members
language sql stable security definer set search_path = public
as $$
  select m.* from members m
  join organizations o on o.id = m.org_id
  where m.user_id = auth.uid() and m.status = 'active' and o.status = 'active'
$$;

create or replace function public.ciq_is_platform_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from platform_admins where user_id = auth.uid())
$$;

-- Territories the caller may see (all of the company for owners/admins)
create or replace function public.ciq_visible_territories()
returns setof uuid
language sql stable security definer set search_path = public
as $$
  select t.id from territories t, ciq_me() me
  where me.user_id is not null and t.org_id = me.org_id
    and (me.role in ('owner', 'admin')
         or exists (select 1 from member_territories mt where mt.user_id = me.user_id and mt.territory_id = t.id))
$$;

-- ── Row level security ─────────────────────────────────────────────────────
alter table public.organizations      enable row level security;
alter table public.territories        enable row level security;
alter table public.members            enable row level security;
alter table public.member_territories enable row level security;
alter table public.publishes          enable row level security;
alter table public.hcps               enable row level security;
alter table public.platform_admins    enable row level security;

create policy org_read on public.organizations for select to authenticated
  using (id = (select org_id from public.ciq_me()) or public.ciq_is_platform_admin());

create policy territory_read on public.territories for select to authenticated
  using (id in (select public.ciq_visible_territories()));

create policy member_read on public.members for select to authenticated
  using (user_id = auth.uid()
         or (org_id = (select org_id from public.ciq_me())
             and (select role from public.ciq_me()) in ('owner', 'admin')));

create policy member_territory_read on public.member_territories for select to authenticated
  using (user_id = auth.uid()
         or (territory_id in (select public.ciq_visible_territories())
             and (select role from public.ciq_me()) in ('owner', 'admin')));

create policy publish_read on public.publishes for select to authenticated
  using (org_id = (select org_id from public.ciq_me())
         and (select role from public.ciq_me()) in ('owner', 'admin'));

create policy hcp_read on public.hcps for select to authenticated
  using (live and territory_id in (select public.ciq_visible_territories()));

create policy platform_admin_read on public.platform_admins for select to authenticated
  using (user_id = auth.uid());

-- No insert/update/delete policies: all writes go through the functions below.
revoke all on all tables in schema public from anon;
grant select on all tables in schema public to authenticated;

-- ── Caller summary (used by the server on every request) ───────────────────
create or replace function public.ciq_my_access()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  m members; o organizations; result jsonb;
begin
  if auth.uid() is null then return null; end if;
  select * into m from members where user_id = auth.uid();
  if found then select * into o from organizations where id = m.org_id; end if;
  result := jsonb_build_object(
    'user_id', auth.uid(),
    'platform_admin', ciq_is_platform_admin(),
    'member', case when m.user_id is null then null else jsonb_build_object(
      'role', m.role, 'status', m.status, 'email', m.email, 'full_name', m.full_name) end,
    'org', case when o.id is null then null else jsonb_build_object('id', o.id, 'name', o.name, 'status', o.status) end,
    'active', (m.user_id is not null and m.status = 'active' and o.status = 'active'),
    'territories', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name)
      from territories t where t.id in (select ciq_visible_territories())), '[]'::jsonb)
  );
  return result;
end
$$;

-- ── Rep app: the doctor list for the caller (row level security applies) ──
create or replace function public.ciq_app_hcps(p_offset integer default 0, p_limit integer default 1000)
returns table (data jsonb)
language sql stable security invoker set search_path = public
as $$
  select h.data || jsonb_build_object('territory', t.name)
  from hcps h join territories t on t.id = h.territory_id
  order by t.name, h.id
  offset greatest(p_offset, 0) limit least(greatest(p_limit, 1), 5000)
$$;

-- ── Company admin ──────────────────────────────────────────────────────────
create or replace function public.ciq_require_admin()
returns public.members
language plpgsql stable security definer set search_path = public
as $$
declare me members;
begin
  select * into me from ciq_me();
  if me.user_id is null or me.role not in ('owner', 'admin') then
    raise exception 'Only company owners and admins can do this' using errcode = '42501';
  end if;
  return me;
end
$$;

create or replace function public.ciq_admin_overview()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare me members;
begin
  me := ciq_require_admin();
  return jsonb_build_object(
    'org', (select jsonb_build_object('id', id, 'name', name, 'status', status) from organizations where id = me.org_id),
    'me', jsonb_build_object('user_id', me.user_id, 'role', me.role),
    'territories', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name,
        'hcp_count', (select count(*) from hcps h where h.territory_id = t.id and h.live)) order by t.name)
      from territories t where t.org_id = me.org_id), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', m.email, 'full_name', m.full_name,
        'role', m.role, 'status', m.status, 'created_at', m.created_at,
        'territory_ids', coalesce((select jsonb_agg(mt.territory_id) from member_territories mt where mt.user_id = m.user_id), '[]'::jsonb))
        order by m.full_name, m.email)
      from members m where m.org_id = me.org_id), '[]'::jsonb),
    'last_publish', (select jsonb_build_object('at', p.finished_at, 'hcp_count', p.hcp_count, 'territory_count', p.territory_count)
      from publishes p where p.org_id = me.org_id and p.status = 'done' order by p.finished_at desc limit 1)
  );
end
$$;

-- Role changes: admins manage managers and reps; only owners manage owners and admins.
create or replace function public.ciq_check_role_change(me public.members, p_old_role text, p_new_role text)
returns void
language plpgsql immutable
as $$
begin
  if p_new_role not in ('owner', 'admin', 'manager', 'rep') then
    raise exception 'Unknown role %', p_new_role using errcode = '22023';
  end if;
  if me.role <> 'owner' and (p_new_role in ('owner', 'admin') or coalesce(p_old_role, 'rep') in ('owner', 'admin')) then
    raise exception 'Only an owner can add or change owners and admins' using errcode = '42501';
  end if;
end
$$;

create or replace function public.ciq_set_member_territories(p_org uuid, p_user uuid, p_territories uuid[])
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if exists (select 1 from unnest(coalesce(p_territories, '{}')) tid
             where not exists (select 1 from territories t where t.id = tid and t.org_id = p_org)) then
    raise exception 'Territory is not in this company' using errcode = '22023';
  end if;
  delete from member_territories where user_id = p_user;
  insert into member_territories (user_id, territory_id)
    select p_user, tid from unnest(coalesce(p_territories, '{}')) tid on conflict do nothing;
end
$$;
revoke execute on function public.ciq_set_member_territories(uuid, uuid, uuid[]) from public, anon, authenticated;

-- Called by the server right after it creates/invites the auth user
create or replace function public.ciq_admin_add_member(p_user uuid, p_email text, p_full_name text, p_role text, p_territories uuid[])
returns void
language plpgsql security definer set search_path = public
as $$
declare me members; existing members;
begin
  me := ciq_require_admin();
  perform ciq_check_role_change(me, null, p_role);
  select * into existing from members where user_id = p_user;
  if found and existing.org_id <> me.org_id then
    raise exception 'That email already belongs to another company' using errcode = '23505';
  end if;
  insert into members (user_id, org_id, role, status, email, full_name)
    values (p_user, me.org_id, p_role, 'active', lower(trim(p_email)), coalesce(trim(p_full_name), ''))
    on conflict (user_id) do update set role = excluded.role, full_name = excluded.full_name, status = 'active';
  perform ciq_set_member_territories(me.org_id, p_user, p_territories);
end
$$;

-- Returns the member's new status
create or replace function public.ciq_admin_update_member(p_user uuid, p_role text default null,
  p_territories uuid[] default null, p_status text default null, p_full_name text default null)
returns text
language plpgsql security definer set search_path = public
as $$
declare me members; target members;
begin
  me := ciq_require_admin();
  select * into target from members where user_id = p_user and org_id = me.org_id;
  if not found then raise exception 'No such person in this company' using errcode = 'P0002'; end if;
  if p_status is not null and p_status not in ('active', 'disabled') then
    raise exception 'Unknown status %', p_status using errcode = '22023';
  end if;
  if p_user = me.user_id and (p_status = 'disabled' or (p_role is not null and p_role <> me.role)) then
    raise exception 'You can’t disable yourself or change your own role' using errcode = '42501';
  end if;
  if target.role in ('owner', 'admin') and me.role <> 'owner' then
    raise exception 'Only an owner can change owners and admins' using errcode = '42501';
  end if;
  if p_role is not null and p_role <> target.role then
    perform ciq_check_role_change(me, target.role, p_role);
  end if;
  if target.role = 'owner' and ((p_role is not null and p_role <> 'owner') or p_status = 'disabled')
     and (select count(*) from members where org_id = me.org_id and role = 'owner' and status = 'active') <= 1 then
    raise exception 'A company needs at least one active owner' using errcode = '42501';
  end if;
  update members set
    role = coalesce(p_role, role),
    status = coalesce(p_status, status),
    full_name = coalesce(nullif(trim(p_full_name), ''), full_name)
  where user_id = p_user;
  if p_territories is not null then perform ciq_set_member_territories(me.org_id, p_user, p_territories); end if;
  return (select status from members where user_id = p_user);
end
$$;

-- ── Publishing doctor data (from the admin tool) ───────────────────────────
-- begin → rows (in chunks) → finish. New rows stay hidden (live = false) until finish,
-- which swaps atomically: the new rows go live and the previous publish's rows are deleted.
create or replace function public.ciq_publish_begin()
returns uuid
language plpgsql security definer set search_path = public
as $$
declare me members; pid uuid;
begin
  me := ciq_require_admin();
  update publishes set status = 'abandoned' where org_id = me.org_id and status = 'open';
  delete from hcps where org_id = me.org_id
    and publish_id in (select id from publishes where org_id = me.org_id and status = 'abandoned');
  insert into publishes (org_id, created_by) values (me.org_id, me.user_id) returning id into pid;
  return pid;
end
$$;

-- p_rows: JSON array of HCP objects as the app uses them; each needs a "territory" name
create or replace function public.ciq_publish_rows(p_publish uuid, p_rows jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare me members; pub publishes; n integer;
begin
  me := ciq_require_admin();
  select * into pub from publishes where id = p_publish and org_id = me.org_id and status = 'open';
  if not found then raise exception 'This publish is no longer open — start again' using errcode = 'P0002'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'Send rows as an array of at most 5000' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r where length(trim(coalesce(r->>'territory', ''))) = 0) then
    raise exception 'Every doctor needs a territory' using errcode = '22023';
  end if;
  insert into territories (org_id, name)
    select distinct me.org_id, trim(r->>'territory') from jsonb_array_elements(p_rows) r
    on conflict (org_id, name) do nothing;
  insert into hcps (org_id, territory_id, publish_id, npi, data)
    select me.org_id, t.id, p_publish, nullif(regexp_replace(coalesce(r->>'npi', ''), '\D', '', 'g'), ''), r - 'territory'
    from jsonb_array_elements(p_rows) r
    join territories t on t.org_id = me.org_id and t.name = trim(r->>'territory');
  get diagnostics n = row_count;
  return n;
end
$$;

create or replace function public.ciq_publish_finish(p_publish uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare me members; pub publishes; n integer; tn integer;
begin
  me := ciq_require_admin();
  select * into pub from publishes where id = p_publish and org_id = me.org_id and status = 'open' for update;
  if not found then raise exception 'This publish is no longer open — start again' using errcode = 'P0002'; end if;
  select count(*), count(distinct territory_id) into n, tn from hcps where publish_id = p_publish;
  if n = 0 then raise exception 'Nothing was published — no doctors received' using errcode = '22023'; end if;
  delete from hcps where org_id = me.org_id and publish_id <> p_publish;
  update hcps set live = true where publish_id = p_publish;
  update publishes set status = 'done', finished_at = now(), hcp_count = n, territory_count = tn where id = p_publish;
  return jsonb_build_object('hcp_count', n, 'territory_count', tn);
end
$$;

-- ── Platform (the CompassIQ team) ──────────────────────────────────────────
create or replace function public.ciq_require_platform_admin()
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if not ciq_is_platform_admin() then
    raise exception 'CompassIQ team only' using errcode = '42501';
  end if;
end
$$;

create or replace function public.ciq_platform_orgs()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  perform ciq_require_platform_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'status', o.status, 'created_at', o.created_at,
      'members', (select count(*) from members m where m.org_id = o.id),
      'active_members', (select count(*) from members m where m.org_id = o.id and m.status = 'active'),
      'territories', (select count(*) from territories t where t.org_id = o.id),
      'hcps', (select count(*) from hcps h where h.org_id = o.id and h.live),
      'owners', coalesce((select jsonb_agg(m.email) from members m where m.org_id = o.id and m.role = 'owner'), '[]'::jsonb))
      order by o.name)
    from organizations o), '[]'::jsonb);
end
$$;

create or replace function public.ciq_platform_create_org(p_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare oid uuid;
begin
  perform ciq_require_platform_admin();
  insert into organizations (name) values (trim(p_name)) returning id into oid;
  return oid;
end
$$;

-- Called by the server after it invites the owner's login
create or replace function public.ciq_platform_add_owner(p_org uuid, p_user uuid, p_email text, p_full_name text)
returns void
language plpgsql security definer set search_path = public
as $$
declare existing members;
begin
  perform ciq_require_platform_admin();
  if not exists (select 1 from organizations where id = p_org) then
    raise exception 'No such company' using errcode = 'P0002';
  end if;
  select * into existing from members where user_id = p_user;
  if found and existing.org_id <> p_org then
    raise exception 'That email already belongs to another company' using errcode = '23505';
  end if;
  insert into members (user_id, org_id, role, status, email, full_name)
    values (p_user, p_org, 'owner', 'active', lower(trim(p_email)), coalesce(trim(p_full_name), ''))
    on conflict (user_id) do update set role = 'owner', status = 'active';
end
$$;

-- Returns how many active people the change affects
create or replace function public.ciq_platform_set_status(p_org uuid, p_status text)
returns integer
language plpgsql security definer set search_path = public
as $$
begin
  perform ciq_require_platform_admin();
  if p_status not in ('active', 'suspended') then
    raise exception 'Unknown status %', p_status using errcode = '22023';
  end if;
  update organizations set status = p_status where id = p_org;
  if not found then raise exception 'No such company' using errcode = 'P0002'; end if;
  return (select count(*) from members where org_id = p_org and status = 'active');
end
$$;

-- Functions are callable by signed-in users only (each checks the caller itself)
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.ciq_my_access(), public.ciq_app_hcps(integer, integer),
  public.ciq_admin_overview(), public.ciq_admin_add_member(uuid, text, text, text, uuid[]),
  public.ciq_admin_update_member(uuid, text, uuid[], text, text),
  public.ciq_publish_begin(), public.ciq_publish_rows(uuid, jsonb), public.ciq_publish_finish(uuid),
  public.ciq_platform_orgs(), public.ciq_platform_create_org(text),
  public.ciq_platform_add_owner(uuid, uuid, text, text), public.ciq_platform_set_status(uuid, text)
  to authenticated;
-- Helpers used inside policies must stay callable by the policies' role
grant execute on function public.ciq_me(), public.ciq_is_platform_admin(), public.ciq_visible_territories() to authenticated;
