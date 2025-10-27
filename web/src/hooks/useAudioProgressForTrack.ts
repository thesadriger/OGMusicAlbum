import { useEffect, useRef, useState } from "react";

type Progress = { current: number; duration: number; pct: number };
type Opts = {
  audio: HTMLAudioElement | null;
  throttleMs?: number; // раз в N мс обновляем состояние (по умолчанию ~5 Гц)
};

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const mk = (c: number, d: number): Progress => {
  const duration = Number.isFinite(d) && d > 0 ? d : 0;
  const current = clamp(c || 0, 0, duration || 0);
  const pct = duration > 0 ? current / duration : 0;
  return { current, duration, pct };
};

export function useAudioProgressForTrack({ audio, throttleMs = 200 }: Opts) {
  const [progress, setProgress] = useState<Progress>(mk(0, 0));
  const lastEmit = useRef(0);

  useEffect(() => {
    if (!audio) return;

    const emit = () => {
      const now = performance.now();
      if (now - lastEmit.current < throttleMs) return;
      lastEmit.current = now;

      const d = Number.isFinite(audio.duration) ? audio.duration : 0;
      const c = audio.currentTime || 0;

      // обновляем только когда реально меняется
      setProgress((prev) => {
        if (prev.current === c && prev.duration === d) return prev;
        return mk(c, d);
      });
    };

    const onMeta = () => setProgress(mk(audio.currentTime || 0, audio.duration || 0));
    const onEnded = () => setProgress(mk(0, audio.duration || 0));

    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("timeupdate", emit);
    audio.addEventListener("seeked", emit);
    audio.addEventListener("playing", emit);
    audio.addEventListener("pause", emit);
    audio.addEventListener("ended", onEnded);

    // первичный снимок
    onMeta(); emit();

    return () => {
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("timeupdate", emit);
      audio.removeEventListener("seeked", emit);
      audio.removeEventListener("playing", emit);
      audio.removeEventListener("pause", emit);
      audio.removeEventListener("ended", onEnded);
    };
  }, [audio, throttleMs]);

  return progress;
}
