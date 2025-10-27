-- users
create table if not exists users (
  telegram_id   bigint primary key,
  username      text,
  name          text,
  photo_url     text,
  is_discoverable boolean default false,
  created_at    timestamptz not null default now()
);

-- favorites
create table if not exists favorites (
  user_id   bigint references users(telegram_id) on delete cascade,
  track_id  uuid   not null,
  ts        timestamptz not null default now(),
  primary key (user_id, track_id)
);

-- history
create type user_action as enum ('play','search','save');
create table if not exists history (
  user_id   bigint references users(telegram_id) on delete cascade,
  track_id  uuid,
  action    user_action not null,
  ts        timestamptz not null default now()
);

-- полезные индексы
create index if not exists favorites_user_ts_idx on favorites(user_id, ts desc);
create index if not exists history_user_ts_idx   on history(user_id, ts desc);
