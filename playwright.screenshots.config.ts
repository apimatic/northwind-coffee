import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/** Captures full-page screenshots of every page at 1440 px and 390 px (see e2e/screenshots.spec.ts). */
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: "**/screenshots.spec.ts",
});
