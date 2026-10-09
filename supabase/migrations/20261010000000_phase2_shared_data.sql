-- CompassIQ cloud — Phase 2: what reps enter is kept in the cloud.
--
--   hcp_prefs       doctor preferences shared across the company, one row per doctor (NPI):
--                   office hours / locations by day, do-not-call, by-appointment-only, and a
--                   corrected main address. Anyone who can see the doctor sees the latest.
--   visit_outcomes  done / missed per visit, per person who logged it.
--   rep_state       each person's own plan and settings (the app's saved state), so they can
--                   sign in on another iPad, or move territory, without losing anything.
--
-- Reads go through row level security; writes go through ciq_sync / ciq_save_state, which only
-- accept doctors the caller can see.

create table public.hcp_prefs (
  org_id      uuid not null references public.organizations(id) on delete cascade,
  npi         text not null,
  prefs       jsonb not null default '{}'::jsonb,
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (org_id, npi)
);

create table public.visit_outcomes (
  org_id      uuid not null references public.organizations(id) on delete cascade,
  npi         text not null,
  visit_date  date not null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  status      text not null check (status in ('done', 'missed')),
  reason      text not null default '',
  logged_at   timestamptz not null default now(),
  primary key (org_id, npi, visit_date, user_id)
);
create index visit_outcomes_user_idx on public.visit_outcomes (user_id, visit_date);

create table public.rep_state (
  user_id     uuid primary key references public.members(user_id) on delete cascade,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

create index hcps_org_npi_idx on public.hcps (org_id, npi) where live;

-- NPIs the caller may see (doctors in their visible territories)
create or replace function public.ciq_visible_npis()
returns setof text
language sql stable security definer set search_path = public
as $$
  select distinct h.npi from hcps h
  where h.live and h.npi is not null and h.territory_id in (select ciq_visible_territories())
$$;

alter table public.hcp_prefs      enable row level security;
alter table public.visit_outcomes enable row level security;
alter table public.rep_state      enable row level security;

create policy hcp_prefs_read on public.hcp_prefs for select to authenticated
  using (org_id = (select org_id from public.ciq_me()) and npi in (select public.ciq_visible_npis()));

create policy visit_outcomes_read on public.visit_outcomes for select to authenticated
  using (org_id = (select org_id from public.ciq_me())
         and (user_id = auth.uid()
              or ((select role from public.ciq_me()) in ('owner', 'admin', 'manager') and npi in (select public.ciq_visible_npis()))));

create policy rep_state_read on public.rep_state for select to authenticated
  using (user_id = auth.uid() and org_id = (select org_id from public.ciq_me()));

revoke all on public.hcp_prefs, public.visit_outcomes, public.rep_state from anon;
grant select on public.hcp_prefs, public.visit_outcomes, public.rep_state to authenticated;

-- ── Rep app doctor list: published data with the company's shared preferences on top ────────
create or replace function public.ciq_app_hcps(p_offset integer default 0, p_limit integer default 1000)
returns table (data jsonb)
language sql stable security invoker set search_path = public
as $$
  select h.data
    || jsonb_build_object('territory', t.name)
    || coalesce(
         (select jsonb_strip_nulls(jsonb_build_object(
             'daySchedule', case when p.prefs ? 'daySchedule' then p.prefs->'daySchedule' end,
             'doNotCall', p.prefs->'doNotCall',
             'byAppointmentOnly', p.prefs->'byAppointmentOnly',
             'address', p.prefs->'address'->'address',
             'city', p.prefs->'address'->'city',
             'state', p.prefs->'address'->'state',
             'zip5', p.prefs->'address'->'zip5',
             'zip4', p.prefs->'address'->'zip4',
             'addrEdited', case when p.prefs ? 'address' then to_jsonb(true) end,
             'prefsAt', to_jsonb(p.updated_at)))
          from hcp_prefs p where p.org_id = h.org_id and p.npi = h.npi),
         '{}'::jsonb)
  from hcps h join territories t on t.id = h.territory_id
  order by t.name, h.id
  offset greatest(p_offset, 0) limit least(greatest(p_limit, 1), 5000)
$$;

-- ── Sync from the rep app ──────────────────────────────────────────────────────────────────────
-- p_outcomes: [{ date, npi, status: done|missed|cleared, reason, loggedAt }]
-- p_prefs:    [{ npi, daySchedule, doNotCall, byAppointmentOnly, address: {address,city,state,zip5,zip4}|null }]
-- Rows for doctors the caller can't see are ignored. Returns how many of each were saved.
create or replace function public.ciq_sync(p_outcomes jsonb, p_prefs jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare me members; n_o integer := 0; n_p integer := 0; n integer;
begin
  select * into me from ciq_me();
  if me.user_id is null then raise exception 'Your CompassIQ access is turned off' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_outcomes, '[]')) <> 'array' or jsonb_typeof(coalesce(p_prefs, '[]')) <> 'array'
     or jsonb_array_length(coalesce(p_outcomes, '[]')) > 2000 or jsonb_array_length(coalesce(p_prefs, '[]')) > 1000 then
    raise exception 'Send outcomes and preferences as arrays (up to 2000 / 1000)' using errcode = '22023';
  end if;

  -- Outcomes
  delete from visit_outcomes v using jsonb_array_elements(coalesce(p_outcomes, '[]')) o
  where o->>'status' = 'cleared' and v.org_id = me.org_id and v.user_id = me.user_id
    and v.npi = o->>'npi' and v.visit_date = (o->>'date')::date;
  insert into visit_outcomes (org_id, npi, visit_date, user_id, status, reason, logged_at)
    select me.org_id, o->>'npi', (o->>'date')::date, me.user_id, o->>'status', left(coalesce(o->>'reason', ''), 300),
           coalesce((o->>'loggedAt')::timestamptz, now())
    from jsonb_array_elements(coalesce(p_outcomes, '[]')) o
    where o->>'status' in ('done', 'missed') and (o->>'date') ~ '^\d{4}-\d{2}-\d{2}$'
      and o->>'npi' in (select ciq_visible_npis())
    on conflict (org_id, npi, visit_date, user_id) do update
      set status = excluded.status, reason = excluded.reason, logged_at = excluded.logged_at;
  get diagnostics n_o = row_count;

  -- Doctor preferences (latest wins; an address is only replaced when one is sent)
  insert into hcp_prefs as hp (org_id, npi, prefs, updated_by, updated_at)
    select me.org_id, p->>'npi',
           jsonb_build_object('daySchedule', coalesce(p->'daySchedule', 'null'::jsonb),
                              'doNotCall', coalesce((p->>'doNotCall')::boolean, false),
                              'byAppointmentOnly', coalesce((p->>'byAppointmentOnly')::boolean, false))
             || case when jsonb_typeof(p->'address') = 'object' then jsonb_build_object('address', jsonb_build_object(
                  'address', left(p->'address'->>'address', 200), 'city', left(p->'address'->>'city', 100),
                  'state', left(p->'address'->>'state', 2), 'zip5', left(p->'address'->>'zip5', 5),
                  'zip4', left(coalesce(p->'address'->>'zip4', p->'address'->>'zip5'), 10))) else '{}'::jsonb end,
           me.user_id, now()
    from jsonb_array_elements(coalesce(p_prefs, '[]')) p
    where p->>'npi' in (select ciq_visible_npis())
    on conflict (org_id, npi) do update
      set prefs = (hp.prefs - 'daySchedule' - 'doNotCall' - 'byAppointmentOnly') || excluded.prefs,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  get diagnostics n_p = row_count;

  return jsonb_build_object('outcomes', n_o, 'prefs', n_p);
end
$$;

-- Shared preferences for the caller's doctors (the app fills in what it doesn't have yet)
create or replace function public.ciq_shared_prefs()
returns jsonb
language sql stable security invoker set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('npi', p.npi, 'daySchedule', p.prefs->'daySchedule',
           'doNotCall', coalesce((p.prefs->>'doNotCall')::boolean, false),
           'byAppointmentOnly', coalesce((p.prefs->>'byAppointmentOnly')::boolean, false),
           'address', p.prefs->'address', 'updatedAt', p.updated_at)), '[]'::jsonb)
  from hcp_prefs p
$$;

-- ── Each person's plan and settings ────────────────────────────────────────────────────────────
create or replace function public.ciq_save_state(p_data jsonb)
returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare me members; at timestamptz := now();
begin
  select * into me from ciq_me();
  if me.user_id is null then raise exception 'Your CompassIQ access is turned off' using errcode = '42501'; end if;
  if jsonb_typeof(p_data) <> 'object' or octet_length(p_data::text) > 4000000 then
    raise exception 'Plan data is missing or too large' using errcode = '22023';
  end if;
  insert into rep_state (user_id, org_id, data, updated_at) values (me.user_id, me.org_id, p_data, at)
    on conflict (user_id) do update set data = excluded.data, org_id = excluded.org_id, updated_at = excluded.updated_at;
  return at;
end
$$;

-- When the server copy is newer than `p_since` (or there is no local copy), return it
create or replace function public.ciq_my_state(p_since timestamptz default null)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  select case when s.user_id is null then null
              when p_since is not null and s.updated_at <= p_since then jsonb_build_object('at', s.updated_at)
              else jsonb_build_object('at', s.updated_at, 'data', s.data) end
  from (select 1) one left join rep_state s on s.user_id = auth.uid()
$$;

revoke execute on function public.ciq_visible_npis(), public.ciq_app_hcps(integer, integer), public.ciq_sync(jsonb, jsonb),
  public.ciq_shared_prefs(), public.ciq_save_state(jsonb), public.ciq_my_state(timestamptz) from public, anon;
grant execute on function public.ciq_visible_npis(), public.ciq_app_hcps(integer, integer), public.ciq_sync(jsonb, jsonb),
  public.ciq_shared_prefs(), public.ciq_save_state(jsonb), public.ciq_my_state(timestamptz) to authenticated;
