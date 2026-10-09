-- CompassIQ cloud — call activity feed and manager team view.
--
--   call_activity   completed calls from the client's data warehouse (or an admin upload),
--                   one per doctor per day. Reps' apps pull them to plan the rest of the quarter.
--   activity_loads  each load: how far the data goes ("calls through"), how many rows, from where.
--   org_api_keys    secret keys a company's data warehouse uses to send calls (only a hash is kept).
--
-- Team view: ciq_team_overview gives owners, admins and managers each rep's progress this quarter
-- and their plan for a week, for the reps in their territories.

create table public.call_activity (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  npi        text not null,
  call_date  date not null,
  call_type  text not null default '',
  source     text not null default 'warehouse',
  loaded_at  timestamptz not null default now(),
  primary key (org_id, npi, call_date)
);

create table public.activity_loads (
  id            bigint generated always as identity primary key,
  org_id        uuid not null references public.organizations(id) on delete cascade,
  through_date  date not null,
  row_count     integer not null default 0,
  source        text not null,
  loaded_by     uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index activity_loads_org_idx on public.activity_loads (org_id, created_at desc);

create table public.org_api_keys (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  label         text not null default '',
  key_hash      text not null unique,
  key_hint      text not null default '',
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

alter table public.call_activity  enable row level security;
alter table public.activity_loads enable row level security;
alter table public.org_api_keys   enable row level security;

create policy call_activity_read on public.call_activity for select to authenticated
  using (org_id = (select org_id from public.ciq_me()) and npi in (select public.ciq_visible_npis()));
-- activity_loads and org_api_keys: read through the admin functions only
revoke all on public.call_activity, public.activity_loads, public.org_api_keys from anon, authenticated;
grant select on public.call_activity to authenticated;

-- ── Loading calls ──────────────────────────────────────────────────────────────────────────────
-- p_rows: [{ npi, date, type?, status? }]. Rows whose status says the call didn't happen
-- (planned, cancelled, …) are skipped; one call per doctor per day is kept.
-- Called by the server with the service role (warehouse key) or through ciq_admin_load_activity.
create or replace function public.ciq_ingest_activity(p_org uuid, p_through date, p_rows jsonb, p_source text, p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare n integer; through date;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'Send calls as an array of at most 5000' using errcode = '22023';
  end if;
  insert into call_activity (org_id, npi, call_date, call_type, source)
    select p_org, npi, d, max(t), left(p_source, 20)
    from (
      select regexp_replace(coalesce(r->>'npi', ''), '\D', '', 'g') npi,
             (r->>'date')::date d, left(coalesce(r->>'type', ''), 40) t
      from jsonb_array_elements(p_rows) r
      where coalesce(r->>'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
        and lower(regexp_replace(coalesce(r->>'status', ''), '[^a-zA-Z]', '', 'g'))
            !~ '^(plan|schedul|cancel|delet|draft|saved|pending|missed|declin|void|notsubmit|open)'
    ) x
    where npi <> ''
    group by npi, d
    on conflict (org_id, npi, call_date) do update set call_type = excluded.call_type, loaded_at = now();
  get diagnostics n = row_count;
  through := coalesce(p_through, (select max((r->>'date')::date) from jsonb_array_elements(p_rows) r
                                  where coalesce(r->>'date', '') ~ '^\d{4}-\d{2}-\d{2}$'));
  if through is null then raise exception 'No calls with a readable date' using errcode = '22023'; end if;
  insert into activity_loads (org_id, through_date, row_count, source, loaded_by) values (p_org, through, n, left(p_source, 20), p_user);
  return jsonb_build_object('rows', n, 'through', through);
end
$$;
revoke execute on function public.ciq_ingest_activity(uuid, date, jsonb, text, uuid) from public, anon, authenticated;

create or replace function public.ciq_admin_load_activity(p_through date, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare me members;
begin
  me := ciq_require_admin();
  return ciq_ingest_activity(me.org_id, p_through, p_rows, 'upload', me.user_id);
end
$$;

-- Which company a warehouse key belongs to (server, service role only); notes when it was used
create or replace function public.ciq_key_org(p_hash text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare oid uuid;
begin
  update org_api_keys k set last_used_at = now()
    from organizations o
    where k.key_hash = p_hash and k.revoked_at is null and o.id = k.org_id and o.status = 'active'
    returning k.org_id into oid;
  return oid;
end
$$;
revoke execute on function public.ciq_key_org(text) from public, anon, authenticated;

create or replace function public.ciq_admin_create_key(p_label text, p_hash text, p_hint text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare me members; kid uuid;
begin
  me := ciq_require_admin();
  if (select count(*) from org_api_keys where org_id = me.org_id and revoked_at is null) >= 10 then
    raise exception 'Revoke an unused key first (10 at most)' using errcode = '22023';
  end if;
  insert into org_api_keys (org_id, label, key_hash, key_hint, created_by)
    values (me.org_id, left(coalesce(p_label, ''), 80), p_hash, left(p_hint, 20), me.user_id) returning id into kid;
  return kid;
end
$$;

create or replace function public.ciq_admin_revoke_key(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare me members;
begin
  me := ciq_require_admin();
  update org_api_keys set revoked_at = now() where id = p_id and org_id = me.org_id and revoked_at is null;
  if not found then raise exception 'No such key' using errcode = 'P0002'; end if;
end
$$;

create or replace function public.ciq_admin_activity_overview()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare me members;
begin
  me := ciq_require_admin();
  return jsonb_build_object(
    'loads', coalesce((select jsonb_agg(jsonb_build_object('through', l.through_date, 'rows', l.row_count, 'source', l.source, 'at', l.created_at))
              from (select * from activity_loads where org_id = me.org_id order by created_at desc limit 8) l), '[]'::jsonb),
    'calls', (select count(*) from call_activity where org_id = me.org_id),
    'keys', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'label', k.label, 'hint', k.key_hint,
              'created_at', k.created_at, 'last_used_at', k.last_used_at) order by k.created_at desc)
              from org_api_keys k where k.org_id = me.org_id and k.revoked_at is null), '[]'::jsonb));
end
$$;

-- ── Rep app: calls for the caller's doctors since p_from ────────────────────────────────────────
-- Warehouse calls, plus visits marked done in the app before today (by anyone at the company).
-- asOf: how far the warehouse data goes (latest load), or the newest call if none was loaded.
create or replace function public.ciq_my_activity(p_from date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare me members; calls jsonb; through date; newest date;
begin
  select * into me from ciq_me();
  if me.user_id is null then raise exception 'Your CompassIQ access is turned off' using errcode = '42501'; end if;
  with c as (
    select a.npi, a.call_date d, a.call_type t from call_activity a
      where a.org_id = me.org_id and a.call_date >= p_from and a.npi in (select ciq_visible_npis())
    union
    select o.npi, o.visit_date, 'Logged in CompassIQ' from visit_outcomes o
      where o.org_id = me.org_id and o.status = 'done' and o.visit_date >= p_from and o.visit_date < current_date
        and o.npi in (select ciq_visible_npis())
        and not exists (select 1 from call_activity a where a.org_id = me.org_id and a.npi = o.npi and a.call_date = o.visit_date)
  )
  select coalesce(jsonb_agg(jsonb_build_object('npi', npi, 'date', d, 'type', t, 'status', 'Completed')), '[]'::jsonb), max(d)
    into calls, newest from c;
  select max(through_date) into through from activity_loads where org_id = me.org_id;
  return jsonb_build_object('asOf', greatest(through, newest), 'through', through, 'calls', calls);
end
$$;

-- ── Team view ──────────────────────────────────────────────────────────────────────────────────
-- For each rep the caller can see (owners/admins: everyone; managers: reps in their territories):
-- goal and calls this quarter, doctors reached, missed visits, last plan save, and the week's plan.
create or replace function public.ciq_team_overview(p_week_start date, p_q_start date, p_q_end date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare me members;
begin
  select * into me from ciq_me();
  if me.user_id is null or me.role not in ('owner', 'admin', 'manager') then
    raise exception 'Team view is for managers and admins' using errcode = '42501';
  end if;
  return coalesce((
    with reps as (
      select m.* from members m
      where m.org_id = me.org_id and m.role = 'rep'
        and exists (select 1 from member_territories mt where mt.user_id = m.user_id
                    and mt.territory_id in (select ciq_visible_territories()))
    ),
    docs as (
      select r.user_id, h.npi, h.data, greatest(ceil(coalesce(nullif(h.data->>'callGoal', '')::numeric, 4) / 4), 1)::int goal
      from reps r join member_territories mt on mt.user_id = r.user_id
      join hcps h on h.territory_id = mt.territory_id and h.live and h.npi is not null
    ),
    calls as (
      select npi, call_date d from call_activity where org_id = me.org_id and call_date between p_q_start and p_q_end
      union
      select npi, visit_date from visit_outcomes where org_id = me.org_id and status = 'done' and visit_date between p_q_start and p_q_end
    ),
    per_doc as (
      select d.user_id, d.npi, d.goal, d.data, (select count(*) from calls c where c.npi = d.npi)::int done from docs d
    )
    select jsonb_agg(jsonb_build_object(
      'user_id', r.user_id, 'name', r.full_name, 'email', r.email, 'status', r.status,
      'territories', coalesce((select jsonb_agg(t.name order by t.name) from member_territories mt join territories t on t.id = mt.territory_id where mt.user_id = r.user_id), '[]'::jsonb),
      'doctors', (select count(*) from per_doc p where p.user_id = r.user_id),
      'goal', coalesce((select sum(goal) from per_doc p where p.user_id = r.user_id), 0),
      'done', coalesce((select sum(least(done, goal)) from per_doc p where p.user_id = r.user_id), 0),
      'calls', coalesce((select sum(done) from per_doc p where p.user_id = r.user_id), 0),
      'reached', (select count(*) from per_doc p where p.user_id = r.user_id and p.done > 0),
      'missed', (select count(*) from visit_outcomes o where o.org_id = me.org_id and o.user_id = r.user_id and o.status = 'missed'
                   and o.visit_date between p_q_start and p_q_end),
      'missed_list', coalesce((select jsonb_agg(jsonb_build_object('date', o.visit_date, 'npi', o.npi, 'reason', o.reason,
                     'name', (select trim(coalesce(h.data->>'firstName', '') || ' ' || coalesce(h.data->>'lastName', '')) from hcps h
                              where h.org_id = me.org_id and h.npi = o.npi and h.live limit 1)) order by o.visit_date desc)
                   from (select * from visit_outcomes o where o.org_id = me.org_id and o.user_id = r.user_id and o.status = 'missed'
                         and o.visit_date between p_q_start and p_q_end order by o.visit_date desc limit 20) o), '[]'::jsonb),
      'unreached', coalesce((select jsonb_agg(jsonb_build_object('npi', p.npi, 'name', trim(coalesce(p.data->>'firstName', '') || ' ' || coalesce(p.data->>'lastName', '')),
                   'segment', p.data->>'segment', 'city', p.data->>'city') order by p.data->>'segment', p.data->>'lastName')
                   from (select * from per_doc p where p.user_id = r.user_id and p.done = 0 order by p.data->>'segment', p.data->>'lastName' limit 60) p), '[]'::jsonb),
      'plan_saved_at', s.updated_at,
      'plan_calls', coalesce((select count(*) from jsonb_array_elements(coalesce(s.data->'T'->(s.data->>'A')->'data'->'plan', '[]'::jsonb)) v
                   where not coalesce((v->>'isLunch')::boolean, false) and (v->>'date') between p_q_start::text and p_q_end::text), 0),
      'week', coalesce((select jsonb_agg(jsonb_build_object('date', v->>'date', 'time', v->>'callStart', 'name', v->>'name', 'npi', v->>'npi',
                   'city', v->>'city', 'meal', coalesce((v->>'isLunch')::boolean, false),
                   'outcome', (select o.status from visit_outcomes o where o.org_id = me.org_id and o.user_id = r.user_id
                               and o.npi = v->>'npi' and o.visit_date::text = v->>'date'))
                   order by v->>'date', (v->>'callNum')::int)
                   from jsonb_array_elements(coalesce(s.data->'T'->(s.data->>'A')->'data'->'plan', '[]'::jsonb)) v
                   where (v->>'date') between p_week_start::text and (p_week_start + 6)::text), '[]'::jsonb)
    ) order by r.full_name, r.email)
    from reps r left join rep_state s on s.user_id = r.user_id
  ), '[]'::jsonb);
end
$$;

revoke execute on function public.ciq_admin_load_activity(date, jsonb), public.ciq_admin_create_key(text, text, text),
  public.ciq_admin_revoke_key(uuid), public.ciq_admin_activity_overview(), public.ciq_my_activity(date),
  public.ciq_team_overview(date, date, date) from public, anon;
grant execute on function public.ciq_admin_load_activity(date, jsonb), public.ciq_admin_create_key(text, text, text),
  public.ciq_admin_revoke_key(uuid), public.ciq_admin_activity_overview(), public.ciq_my_activity(date),
  public.ciq_team_overview(date, date, date) to authenticated;
grant execute on function public.ciq_ingest_activity(uuid, date, jsonb, text, uuid), public.ciq_key_org(text) to service_role;
