import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Each suite starts an isolated server; combined authentication traffic can hit
// the real per-minute limit. Keep the production limit intact.
export default defineConfig(base, { testMatch: '**/articles.spec.ts' });
