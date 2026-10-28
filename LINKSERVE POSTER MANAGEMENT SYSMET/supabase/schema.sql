create extension if not exists pgcrypto;

create table if not exists public.posters (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text default '',
  image_url text not null,
  drive_file_id text,
  status text not null default 'ready' check (status in ('ready','scheduled','published','archived')),
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);
create table if not exists public.scheduled_posts (
  id uuid primary key default gen_random_uuid(),
  poster_id uuid references public.posters(id) on delete set null,
  poster_title text not null,
  image_url text not null,
  channel text not null default 'Manual sharing',
  caption text default '',
  scheduled_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled','ready_to_share','published','failed','cancelled')),
  created_at timestamptz not null default now()
);
create table if not exists public.posting_history (
  id uuid primary key default gen_random_uuid(),
  poster_title text not null,
  channel text not null,
  result text not null,
  detail text default '',
  posted_at timestamptz not null default now()
);
alter table public.posters enable row level security;
alter table public.scheduled_posts enable row level security;
alter table public.posting_history enable row level security;
-- The Express server uses the service role key. Never expose it in frontend code.
