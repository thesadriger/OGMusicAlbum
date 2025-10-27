import type { Track } from "@/types/types";

declare global {
  interface Window {
    __ogmaPlay?: (t: Track) => void;
  }
}
export {};
