-- Vocal trainings: a teacher's recording and the part (notes) taken from it. No accounts yet:
-- anyone creates one and anyone with its id (the link) reads it. Nothing is updated or deleted
-- from the client. `part` is { version, notes: [{ midi, start, end, ...optional ornaments }] },
-- seconds of the recording (see PartNote in src/training/vocal/part.ts).

create table public.vocal_trainings (
  id uuid primary key default gen_random_uuid(),
  title text not null default '' check (char_length(title) <= 120),
  part jsonb not null check (jsonb_typeof(part) = 'object' and pg_column_size(part) <= 262144),
  audio_path text not null check (char_length(audio_path) <= 200),
  created_at timestamptz not null default now()
);

alter table public.vocal_trainings enable row level security;

create policy "vocal_trainings: anyone reads" on public.vocal_trainings
  for select to anon, authenticated using (true);
create policy "vocal_trainings: anyone creates" on public.vocal_trainings
  for insert to anon, authenticated with check (true);

grant select, insert on public.vocal_trainings to anon, authenticated;

-- Recordings: public to read by URL, anyone uploads, nobody overwrites. 20 MB, audio only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vocal-recordings', 'vocal-recordings', true, 20971520, array['audio/*'])
on conflict (id) do nothing;

create policy "vocal-recordings: anyone uploads" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'vocal-recordings');
