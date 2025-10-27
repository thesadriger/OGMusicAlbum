// src/types/ogma-globals.d.ts
export { };

declare global {
    interface Window {
        /**
         * Жест-плей: вызывается из обработчика клика, чтобы по требованию
         * мгновенно выставить src и дернуть play() в разрешенном контексте.
         */
        __ogmaPlay?: (t: import("@/types/types").Track) => void;
    }
}