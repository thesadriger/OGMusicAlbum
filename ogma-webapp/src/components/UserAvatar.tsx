import React from "react";
import { useMe } from "@/hooks/useMe";

function initials(name?: string | null, username?: string | null) {
  const src = (name || username || "").trim();
  if (!src) return "U";
  const parts = src.split(/\s+/).filter(Boolean);
  const a = (parts[0]?.[0] || username?.[0] || "U").toUpperCase();
  const b = (parts[1]?.[0] || "").toUpperCase();
  return (a + b).slice(0, 2);
}

export const UserAvatar: React.FC = () => {
  const { me, loading } = useMe();
  const label = me?.name || me?.username || "Профиль";

  return (
    <a
      href="#/profile"
      className="inline-flex items-center justify-center rounded-full overflow-hidden ring-1 ring-white/10 bg-black/10 dark:bg-white/10 hover:opacity-90 transition-all cursor-pointer"
      style={{ width: 36, height: 36 }}
      aria-label="Профиль"
      title={label}
    >
      {loading ? (
        <div className="w-full h-full animate-pulse" />
      ) : me?.photo_url ? (
        <img
          src={me.photo_url}
          alt="Аватар пользователя"
          className="w-full h-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className="w-full h-full flex items-center justify-center text-xs font-semibold text-white/90">
          {initials(me?.name, me?.username)}
        </span>
      )}
    </a>
  );
};

export default UserAvatar;