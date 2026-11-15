create extension if not exists pgcrypto;

create table if not exists public.posters (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text default '',
  image_url text not null,
  drive_file_id text,
  storage_path text,
  image_hash text,
  status text not null default 'available',
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.scheduled_posts (
  id uuid primary key default gen_random_uuid(),
  poster_id uuid references public.posters(id) on delete set null,
  poster_title text not null,
  image_url text not null,
  storage_path text,
  channel text not null default 'Viber Community',
  caption text default '',
  scheduled_at timestamptz not null,
  status text not null default 'scheduled',
  created_at timestamptz not null default now()
);

create table if not exists public.posting_history (
  id uuid primary key default gen_random_uuid(),
  poster_id uuid references public.posters(id) on delete set null,
  poster_title text not null,
  channel text not null,
  publication_type text,
  result text not null,
  detail text default '',
  posted_at timestamptz not null default now()
);

alter table public.posters add column if not exists storage_path text;
alter table public.posters add column if not exists image_hash text;
alter table public.scheduled_posts add column if not exists storage_path text;
alter table public.posting_history add column if not exists poster_id uuid references public.posters(id) on delete set null;
alter table public.posting_history add column if not exists publication_type text;

alter table public.posters drop constraint if exists posters_status_check;
update public.posters
set status = case
  when status = 'ready' then 'available'
  when status not in ('available', 'scheduled', 'published', 'archived') then 'available'
  else status
end;
alter table public.posters alter column status set default 'available';
alter table public.posters add constraint posters_status_check
  check (status in ('available', 'scheduled', 'published', 'archived'));

alter table public.scheduled_posts drop constraint if exists scheduled_posts_status_check;
alter table public.scheduled_posts add constraint scheduled_posts_status_check
  check (status in ('scheduled', 'ready_to_share', 'published', 'failed', 'cancelled'));

update public.scheduled_posts s
set storage_path = p.storage_path
from public.posters p
where s.poster_id = p.id and s.storage_path is null and p.storage_path is not null;

with ranked_active_schedules as (
  select id, row_number() over (
    partition by poster_id order by scheduled_at, created_at, id
  ) as position
  from public.scheduled_posts
  where poster_id is not null and status in ('scheduled', 'ready_to_share')
)
update public.scheduled_posts s
set status = 'cancelled'
from ranked_active_schedules r
where s.id = r.id and r.position > 1;

update public.posters p
set status = 'scheduled'
where p.status = 'available'
  and exists (
    select 1 from public.scheduled_posts s
    where s.poster_id = p.id and s.status in ('scheduled', 'ready_to_share')
  );

update public.posting_history h
set poster_id = (
  select p.id
  from public.posters p
  where p.title = h.poster_title
  order by p.created_at, p.id
  limit 1
)
where h.poster_id is null
  and exists (select 1 from public.posters p where p.title = h.poster_title);

with ranked_publications as (
  select id, row_number() over (
    partition by poster_id order by posted_at, id
  ) as position
  from public.posting_history
  where poster_id is not null and result = 'published'
)
update public.posting_history h
set publication_type = case when r.position = 1 then 'First publication' else 'Republished' end
from ranked_publications r
where h.id = r.id and h.publication_type is null;

update public.posting_history
set publication_type = 'First publication'
where publication_type is null;

create unique index if not exists posters_image_hash_unique
  on public.posters(image_hash) where image_hash is not null;
create unique index if not exists scheduled_posts_one_active_per_poster
  on public.scheduled_posts(poster_id)
  where poster_id is not null and status in ('scheduled', 'ready_to_share');
create index if not exists posting_history_poster_publication_idx
  on public.posting_history(poster_id, result, posted_at desc);

alter table public.posters enable row level security;
alter table public.scheduled_posts enable row level security;
alter table public.posting_history enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'linkserve-posters',
  'linkserve-posters',
  false,
  20971520,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'linkserve_admin_manage_posters'
  ) then
    create policy linkserve_admin_manage_posters
      on storage.objects for all to authenticated
      using (
        bucket_id = 'linkserve-posters'
        and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
      )
      with check (
        bucket_id = 'linkserve-posters'
        and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
      );
  end if;
end
$$;
