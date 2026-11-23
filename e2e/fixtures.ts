import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page } from "@playwright/test";

interface ConsoleGuard {
  /**
   * Allows one expected console error, e.g. Chromium's "Failed to load resource ... 404" line
   * when a test deliberately opens a missing page. Every allowance must be used exactly once.
   */
  allowOnce(pattern: RegExp): void;
}

/**
 * Fails the test if the browser logs any console error or uncaught page error (including
 * failed resource loads), other than errors explicitly allowed with `consoleGuard.allowOnce`.
 */
export const test = base.extend<{ consoleGuard: ConsoleGuard }>({
  consoleGuard: [
    async ({ page }, use) => {
      const errors: string[] = [];
      const allowed: { pattern: RegExp; used: boolean }[] = [];
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = `console.error: ${message.text()} (${message.location().url})`;
        const allowance = allowed.find((a) => !a.used && a.pattern.test(text));
        if (allowance) allowance.used = true;
        else errors.push(text);
      });
      page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
      await use({ allowOnce: (pattern) => allowed.push({ pattern, used: false }) });
      expect(errors, "browser console errors").toEqual([]);
      expect(
        allowed.filter((a) => !a.used).map((a) => String(a.pattern)),
        "allowed console errors that never happened",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Runs axe (WCAG 2.x A/AA) and fails on any serious or critical violation. */
export async function expectAccessible(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const summary = results.violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length} nodes)`).join(", ");
  console.log(
    `axe ${name} ${new URL(page.url()).pathname}: ${results.passes.length} rules passed, ` +
      `${results.violations.length} violations${summary ? `: ${summary}` : ""}; serious/critical: ${blocking.length}`,
  );
  expect(
    blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.map((n) => n.target) })),
    `serious/critical axe violations on ${name}`,
  ).toEqual([]);
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}
