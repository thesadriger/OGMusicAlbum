import { useEffect, useState } from "react";
import { apiGet, ApiError } from "@/lib/api";

export type Me = {
  telegram_id: number;
  username?: string | null;
  name?: string | null;
  photo_url?: string | null;
};

export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const resp = await apiGet<{ user: Me }>("/me", { timeoutMs: 10000 });
        if (!cancelled) {
          setMe(resp.user);
          setUnauthorized(false);
          setError(null);
        }
      } catch (e: any) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) {
          setMe(null);
          setUnauthorized(true);
          setError(null);
        } else {
          setMe(null);
          setUnauthorized(false);
          setError(e as Error);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { me, loading, error, unauthorized };
}