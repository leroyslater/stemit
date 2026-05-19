create extension if not exists pgcrypto;

create table if not exists public.tracks (
  id uuid primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  track_name text not null,
  size_bytes bigint,
  source_url text not null,
  bpm numeric,
  musical_key text,
  key_scale text,
  key_label text,
  stems jsonb not null default '[]'::jsonb,
  other_layers jsonb not null default '[]'::jsonb
);

create index if not exists tracks_created_at_idx on public.tracks (created_at desc);
create index if not exists tracks_name_idx on public.tracks (track_name);
create index if not exists tracks_key_label_idx on public.tracks (key_label);

alter table public.tracks enable row level security;

drop policy if exists "Public read tracks" on public.tracks;
create policy "Public read tracks"
on public.tracks
for select
using (true);

insert into storage.buckets (id, name, public)
values ('audio-assets', 'audio-assets', true)
on conflict (id) do nothing;

drop policy if exists "Public read audio assets" on storage.objects;
create policy "Public read audio assets"
on storage.objects
for select
using (bucket_id = 'audio-assets');
