import { streamUrlFor, API_BASE, getInitData } from "@/lib/api";
import { useEffect, useRef, useState } from "react";
import type { Track } from "@/types/types";

export function PlayerBar({
  now,
  paused,
  onEnded,
  onPlayPauseChange,
}: {
  now: Track | null;
  paused?: boolean; // внешний флаг паузы
  onEnded?: () => void;
  onPlayPauseChange?: (paused: boolean) => void; // уведомляем App о play/pause из <audio>
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [pos, setPos] = useState(0);

  // обновляем позицию для UI
  useEffect(() => {
    if (!audioRef.current) return;
    const a = audioRef.current;
    const onTime = () => setPos(a.currentTime);
    a.addEventListener("timeupdate", onTime);
    return () => a.removeEventListener("timeupdate", onTime);
  }, []);

  // синхронизация событий play/pause наружу
  useEffect(() => {
    if (!audioRef.current) return;
    const a = audioRef.current;
    const onPlay = () => onPlayPauseChange?.(false);
    const onPause = () => onPlayPauseChange?.(true);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    return () => {
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
    };
  }, [onPlayPauseChange]);

  // ставим src при смене трека
  useEffect(() => {
    if (!audioRef.current) return;
    const a = audioRef.current;

    if (!now) {
      a.pause();
      a.removeAttribute("src");
      a.load();
      setPos(0);
      return;
    }

    a.src = streamUrlFor(now);
    setPos(0);
    a.load();

    // автозапуск только если не на паузе снаружи
    if (!paused) {
      a.play().catch(() => { /* autoplay guard */ });
    }
  }, [now?.id, now?.msgId, now?.chat]); // источник трека меняется — обновляем src

  // реакция на изменение paused снаружи
  useEffect(() => {
    if (!audioRef.current) return;
    const a = audioRef.current;
    if (!now) return;

    if (paused) {
      a.pause();
    } else {
      a.play().catch(() => { /* silent */ });
    }
  }, [paused, now?.id]);

  // пинги прослушивания: ~раз в 5с отправляем delta_sec
  useEffect(() => {
    if (!audioRef.current || !now) return;
    const a = audioRef.current;

    let raf = 0;
    let acc = 0;
    let last = 0;
    const initData = getInitData();

    const tick = () => {
      if (!document.hidden && !a.paused && !a.seeking) {
        const t = a.currentTime || 0;
        if (last > 0) acc += Math.max(0, t - last);
        last = t;

        if (acc >= 5) {
          const delta = Math.min(15, Math.floor(acc));
          acc = 0;

          const slot = Math.floor(Date.now() / 5000);
          const body: any = { track_id: now.id, delta_sec: delta, tick_key: `${now.id}:${slot}` };
          if ((now as any).chat && (now as any).msgId) {
            body.chat = String((now as any).chat).replace(/^@/, "");
            body.msg_id = (now as any).msgId;
          }

          fetch(`${API_BASE}/me/listen`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "X-Telegram-Init-Data": initData,
            },
            body: JSON.stringify(body),
          }).catch(() => {});
        }
      } else {
        last = 0;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [now?.id, now?.msgId, now?.chat]);

  return (
    <div className="fixed inset-x-0 bottom-0 border-t bg-white/80 dark:bg-zinc-950/80 backdrop-blur p-3">
      <audio ref={audioRef} controls className="w-full" onEnded={onEnded} />
      {now && (
        <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-400 truncate">
          {now.title} — {now.artists?.join(", ")} · {Math.round(pos)}s
        </div>
      )}
    </div>
  );
}