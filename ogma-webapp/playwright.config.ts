import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  webServer: {
    command: 'vite --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'pipe',
  },
  use: {
    baseURL: 'http://localhost:5173/?e2e=1',   // ✅ добавили e2e=1
  },
  projects: [
    { name: 'Pixel 7 dark',  use: { ...devices['Pixel 7'],  colorScheme: 'dark'  } },
    { name: 'Pixel 7 light', use: { ...devices['Pixel 7'],  colorScheme: 'light' } },
    { name: 'iPhone 14 dark',use: { ...devices['iPhone 14 Pro'], colorScheme: 'dark' } },
  ],
});