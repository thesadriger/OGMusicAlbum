create table if not exists user_contacts (
  user_id     bigint references users(telegram_id) on delete cascade,
  contact_tid bigint not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, contact_tid)
);
create index if not exists user_contacts_contact_tid_idx on user_contacts(contact_tid);
