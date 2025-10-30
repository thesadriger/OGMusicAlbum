import { useEffect, useMemo, useState } from "react";
import { apiGet, ApiError } from "@/lib/api";

export type PlaylistListeningTotal = {
  seconds: number;
};

export function usePlaylistListeningTotal(enabled = true) {
  const [seconds, setSeconds] = useState<number | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!enabled) {
      setSeconds(null);
      setError(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      setLoading(true);
      try {
        const response = await apiGet<PlaylistListeningTotal>("/me/listen-seconds?scope=playlists", {
          timeoutMs: 15000,
        });
        if (cancelled) return;
        const value = typeof response?.seconds === "number" ? Math.max(0, response.seconds) : 0;
        setSeconds(value);
        setError(null);
      } catch (err: any) {
        if (cancelled) return;
        setSeconds(null);
        if (err instanceof ApiError && err.status === 401) {
          setError(null);
        } else {
          setError(err instanceof Error ? err : new Error("Failed to load playlist listening totals"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return {
    seconds,
    loading,
    error,
    hasValue: useMemo(() => typeof seconds === "number" && seconds >= 0, [seconds]),
  } as const;
}
