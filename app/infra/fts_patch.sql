-- 1) если ранее пробовали создать функциональный индекс — просто убедимся, что его нет
-- (если его не существует, DROP не обязателен)

-- 2) tsvector-колонка
alter table tracks
  add column if not exists search_tsv tsvector;

-- 3) функция, которая собирает текст и делает to_tsvector
create or replace function tracks_tsv_update() returns trigger language plpgsql as $$
begin
  new.search_tsv :=
    to_tsvector('simple'::regconfig,
      coalesce(new.title,'') || ' ' ||
      array_to_string(coalesce(new.artists,'{}'::text[]),' ') || ' ' ||
      array_to_string(coalesce(new.hashtags,'{}'::text[]),' ') || ' ' ||
      coalesce(new.caption,'')
    );
  return new;
end$$;

-- 4) триггер: обновляем tsv при вставке/изменении полей
drop trigger if exists trg_tracks_tsv on tracks;
create trigger trg_tracks_tsv
before insert or update of title, artists, hashtags, caption
on tracks
for each row execute function tracks_tsv_update();

-- 5) прогоним тсвектор для уже существующих строк
update tracks set title = title;  -- триггер сработает на UPDATE

-- 6) GIN-индекс на колонку
create index if not exists tracks_search_tsv_gin on tracks using gin (search_tsv);
