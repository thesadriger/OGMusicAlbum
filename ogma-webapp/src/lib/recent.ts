// src/lib/recent.ts

import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "artist"; artist: string }
  | { name: "artists"; which: "ru" | "en" };

const KEY = "ogma:recent_artists";

export function pushRecentArtists(artists: string[], max = 50) {
  const norm = (artists || [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (!norm.length) return;

  let prev: string[] = [];
  try { prev = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch {}

  // кладём новые в начало, убираем дубли, режем до max
  const seen = new Set<string>();
  const merged = [...norm, ...prev].filter((a) => {
    if (seen.has(a)) return false;
    seen.add(a);
    return true;
  }).slice(0, max);

  localStorage.setItem(KEY, JSON.stringify(merged));
  window.dispatchEvent(new CustomEvent("ogma:recent-change"));
}

export function getRecentArtists(limit = 12): string[] {
  try {
    const arr: string[] = JSON.parse(localStorage.getItem(KEY) || "[]");
    return arr.slice(0, limit);
  } catch {
    return [];
  }
}

export function goHome() {
  location.hash = "#/";
}

export function goArtist(name: string) {
  location.hash = `#/artist/${encodeURIComponent(name)}`;
}

export function goArtists(which: "ru" | "en") {
  location.hash = `#/artists/${which}`;
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parse(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

function parse(hash: string): Route {
  const h = hash.replace(/^#/, "");
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