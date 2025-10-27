//home/ogma/ogma/ogma-webapp/src/lib/router.ts

import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "artist"; artist: string }
  | { name: "artists"; which: "ru" | "en" }
  | { name: "playlist" }                         // локальный (localStorage)
  | { name: "publicPlaylist"; handle: string }   // публичный по @handle
  | { name: "profile" };

function parse(hash: string): Route {
  const h = (hash || "").replace(/^#/, "");


  if (h.startsWith("/p/")) {
    const raw = decodeURIComponent(h.slice("/p/".length));
    const handle = raw.replace(/^@/, "");
    return { name: "publicPlaylist", handle };
  }

  if (h === "/playlist" || h.startsWith("/playlist")) {
    return { name: "playlist" };
  }

  if (h === "/profile" || h.startsWith("/profile")) {
    return { name: "profile" };
  }

  if (h.startsWith("/artist/")) {
    const artist = decodeURIComponent(h.slice("/artist/".length));
    return { name: "artist", artist };
  }

  if (h.startsWith("/artists/")) {
    const which = h.split("/")[2] as "ru" | "en";
    if (which === "ru" || which === "en") return { name: "artists", which };
  }

  return { name: "home" };
}

export function goHome() { location.hash = "#/"; }
export function goArtist(name: string) { location.hash = `#/artist/${encodeURIComponent(name)}`; }
export function goArtists(which: "ru" | "en") { location.hash = `#/artists/${which}`; }
export function goPlaylist() { location.hash = "#/playlist"; }
export function goProfile() { location.hash = "#/profile"; }

export function goPublicPlaylist(handle: string) {
  const h = (handle || "").replace(/^@/, "");
  location.hash = `#/p/${encodeURIComponent(h)}`;
}
export const goPlaylistHandle = goPublicPlaylist; // алиас оставляем

export function goBackSmart() {
  if (history.length > 1) { history.back(); } else { goHome(); }
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parse(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", onHash);
    if (!location.hash) goHome();
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}