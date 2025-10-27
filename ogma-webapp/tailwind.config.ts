
import type { Config } from "tailwindcss";

export default {
  darkMode: ["class", "dark"], // класс 'dark' на <html>
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;