import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";

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

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const resp = await apiGet<{ user: Me }>("/me", { timeoutMs: 10000 });
        if (!cancelled) setMe(resp.user);
      } catch (e: any) {
        if (!cancelled) setError(e as Error), setMe(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { me, loading, error };
}