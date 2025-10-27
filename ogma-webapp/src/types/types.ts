export type Track = {
  id: string;
  msgId: number;
  chat: string;
  title: string;
  artists: string[];
  hashtags: string[];
  duration: number | null;
  mime: string | null;
  created_at: string;
  reason?: string;
  playbackUrl?: string;
};

export type ApiList<T> = {
  items: T[];
  limit: number;
  offset: number;
  total: number | null;
};