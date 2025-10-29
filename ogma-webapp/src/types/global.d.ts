import type { Track } from "@/types/types";

declare global {
  interface Window {
    __ogmaPlay?: (t: Track) => void;
    __ogmaPause?: () => void;
    __ogmaGetAudio?: () => HTMLAudioElement | null;
  }
}
export {};
