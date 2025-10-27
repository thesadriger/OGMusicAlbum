// lib/theme.ts
// Синхронизируем тему между Telegram WebApp, классом .dark на <html> и OS media-query

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        colorScheme?: 'light' | 'dark';
        /** ✅ добавили: */
        ready?: () => void;
        expand?: () => void;

        onEvent?: (event: 'themeChanged', cb: () => void) => void;
        offEvent?: (event: 'themeChanged', cb: () => void) => void;
      };
    };
  }
}

type Cleanup = () => void;

function readManualOverride(): boolean | null {
  const html = document.documentElement;
  if (html.classList.contains('dark')) return true;
  if (html.classList.contains('light')) return false;
  return null;
}

function readFromTelegram(): boolean | null {
  const scheme = window.Telegram?.WebApp?.colorScheme;
  return scheme ? scheme === 'dark' : null;
}

function readFromOS(): boolean {
  return !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export function syncThemeWithTelegram(): Cleanup {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

  const html = document.documentElement;
  let applying = false;

  const apply = () => {
    if (applying) return;
    applying = true;

    // приоритет: ручной класс -> Telegram -> OS
    const manual = readManualOverride();
    const tg = readFromTelegram();
    const dark = (manual ?? tg ?? readFromOS());

    html.classList.toggle('dark', dark);
    html.classList.toggle('light', !dark);
    // небольшой хинт для системных скроллбаров/форм
    html.style.colorScheme = dark ? 'dark' : 'light';

    applying = false;
  };

  apply();

  // события Telegram
  const tg = window.Telegram?.WebApp;
  const onTgTheme = () => apply();
  tg?.onEvent?.('themeChanged', onTgTheme);

  // изменения темы OS
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  const onMq = () => apply();
  mq?.addEventListener?.('change', onMq);

  // если кто-то вручную меняет класс .dark/.light — переоценим источники
  const mo = new MutationObserver(() => apply());
  mo.observe(html, { attributes: true, attributeFilter: ['class'] });

  // вернуть функцию отписки (на случай HMR или SSR teardown)
  return () => {
    tg?.offEvent?.('themeChanged', onTgTheme);
    mq?.removeEventListener?.('change', onMq);
    mo.disconnect();
  };
}