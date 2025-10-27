create extension if not exists pgcrypto;

create table if not exists tracks (
  id             uuid primary key default gen_random_uuid(),
  chat_username  text not null,
  tg_msg_id      bigint not null,
  title          text,
  artists        text[] default '{}',
  hashtags       text[] default '{}',
  duration_s     int,
  mime           text,
  size_bytes     bigint,
  caption        text,
  created_at     timestamptz default now(),
  doc_id         bigint,
  access_hash    bigint,
  file_ref_b64   text,
  dc_id          int,
  unique (chat_username, tg_msg_id)
);

create index if not exists tracks_search_idx on tracks using gin (
  to_tsvector('simple',
    coalesce(title,'') || ' ' ||
    array_to_string(artists,' ') || ' ' ||
    array_to_string(hashtags,' ') || ' ' ||
    coalesce(caption,'')
  )
);

create table if not exists users (
  telegram_id bigint primary key,
  username    text,
  name        text,
  photo_url   text,
  is_discoverable boolean default false,
  created_at  timestamptz default now()
);

create table if not exists favorites (
  user_id  bigint references users(telegram_id) on delete cascade,
  track_id uuid references tracks(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, track_id)
);

create table if not exists history (
  user_id  bigint references users(telegram_id) on delete cascade,
  track_id uuid references tracks(id) on delete cascade,
  action   text check (action in ('play','search','save')),
  ts       timestamptz default now()
);
