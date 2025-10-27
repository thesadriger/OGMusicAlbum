//home/ogma/ogma/ogma-webapp/src/hooks/useAudioProgressForTrack.ts
import { useEffect, useRef, useState } from "react";

export function useAudioProgressForTrack(
  trackId: string | number,
  resolve: () => {
    audio?: HTMLAudioElement | null;
    isActive?: boolean;
    currentTime?: number;
    duration?: number;
  }
): number {
  const [progress, setProgress] = useState(0);
  const raf = useRef<number | null>(null);
  const elRef = useRef<HTMLAudioElement | null>(null);
  const activeRef = useRef<boolean>(false);
  const getterRef = useRef(resolve);            // 👈 держим функцию в ref

  // всегда указываем на актуальную функцию-резолвер
  getterRef.current = resolve;

  const stopRaf = () => { if (raf.current != null) { cancelAnimationFrame(raf.current); raf.current = null; } };

  const computeAndSet = () => {
    const { audio, isActive, currentTime, duration } = getterRef.current?.() || {};
    const active = !!isActive;
    activeRef.current = active;

    // 1) из audio
    if (audio && !isNaN(audio.duration) && audio.duration > 0) {
      const p = active ? Math.min(1, Math.max(0, audio.currentTime / audio.duration)) : 0;
      // анти-дребезг: не дергаем setState, если не изменилось заметно
      setProgress(prev => (Math.abs(prev - p) >= 0.002 ? p : prev));
      return { el: audio, active };
    }

    // 2) из значений времени
    if (duration && duration > 0) {
      const cur = Math.max(0, currentTime ?? 0);
      const p = active ? Math.min(1, Math.max(0, cur / duration)) : 0;
      setProgress(prev => (Math.abs(prev - p) >= 0.002 ? p : prev));
      return { el: null, active };
    }

    setProgress(prev => (prev === 0 ? prev : 0));
    return { el: audio ?? null, active };
  };

  useEffect(() => {
    stopRaf();

    const onTick = () => {
      const { el: curEl } = computeAndSet();
      if (curEl && curEl !== elRef.current) setEl(curEl);
    };

    const onPlayState = () => {
      const { el: curEl } = computeAndSet();
      if (curEl && !curEl.paused && activeRef.current) startRaf();
      else stopRaf();
    };

    const startRaf = () => {
      stopRaf();
      const loop = () => { onTick(); raf.current = requestAnimationFrame(loop); };
      raf.current = requestAnimationFrame(loop);
    };

    const setEl = (next: HTMLAudioElement | null) => {
      if (elRef.current === next) return;
      if (elRef.current) {
        elRef.current.removeEventListener("timeupdate", onTick);
        elRef.current.removeEventListener("durationchange", onTick);
        elRef.current.removeEventListener("playing", onPlayState);
        elRef.current.removeEventListener("pause", onPlayState);
        elRef.current.removeEventListener("ended", onPlayState);
      }
      elRef.current = next;
      if (next) {
        next.addEventListener("timeupdate", onTick);
        next.addEventListener("durationchange", onTick);
        next.addEventListener("playing", onPlayState);
        next.addEventListener("pause", onPlayState);
        next.addEventListener("ended", onPlayState);
        onTick();
        if (!next.paused && activeRef.current) startRaf();
      }
    };

    // первичный прогон
    const { el } = computeAndSet();
    setEl(el ?? null);

    // периодический пробник (плеер мог смениться)
    const probe = setInterval(() => {
      const { el: curEl } = computeAndSet();
      if (curEl && curEl !== elRef.current) setEl(curEl);
    }, 500);

    return () => {
      clearInterval(probe);
      stopRaf();
      if (elRef.current) {
        elRef.current.removeEventListener("timeupdate", onTick);
        elRef.current.removeEventListener("durationchange", onTick);
        elRef.current.removeEventListener("playing", onPlayState);
        elRef.current.removeEventListener("pause", onPlayState);
        elRef.current.removeEventListener("ended", onPlayState);
      }
      elRef.current = null;
    };
  }, [trackId]);    // 👈 больше НЕ зависит от resolve

  return progress;
}