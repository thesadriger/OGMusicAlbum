import type { Track } from "@/types/types";
import React from "react";

const EVT = "ogma:play";

export function emitPlayTrack(t: Track) {
    window.dispatchEvent(new CustomEvent<Track>(EVT, { detail: t }));
}

export function useOnPlayTrack(handler: (t: Track) => void) {
    // лёгкий подписчик
    React.useEffect(() => {
        const on = (e: Event) => handler((e as CustomEvent<Track>).detail);
        window.addEventListener(EVT, on as EventListener);
        return () => window.removeEventListener(EVT, on as EventListener);
    }, [handler]);
}