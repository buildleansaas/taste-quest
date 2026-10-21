// taste-quest user flows for the ux-review skill (buildleansaas/skills ux-review).
// Run: node ~/dev/buildleansaas/skills/ux-review/scripts/capture.mjs ux/flows.mjs <outDir>
// Each flow walks the path a real user takes, through the same buttons they'd tap.
// Call shot(name) on every screen a user stops on, including menus, errors and
// the finish. Use exact accessible names, so a renamed button fails loudly.
export default {
  base: "http://localhost:3123",
  // Optional. Defaults to phone (iPhone 13), tablet 768, laptop 1280, wide 1680.
  // widths: { phone: { device: "iPhone 13" }, laptop: { width: 1280, height: 800 } },
  // Optional browser context for every flow, e.g. { reducedMotion: "reduce" }.
  // A flow written as { context, run } adds its own (below: location granted vs denied).
  context: {},
  // Shots that must look the same as on main (the demo's first screen). The
  // skill compares these first and treats any unapproved change as must-fix.
  baseline: [{ flow: "demo", shot: "plan" }],
  flows: {
    demo: async ({ page, shot }) => {
      await shot("welcome");
      await page.getByRole("button", { name: "Try the Austin demo" }).click();
      await page.getByRole("button", { name: "I’m here" }).waitFor({ timeout: 45000 });
      await shot("plan");
      await page.getByRole("button", { name: /^Antone’s Nightclub/ }).click();
      await shot("stop-detail", { settle: 1500 });
      await page.getByRole("button", { name: "I’m here" }).click();
      await page.waitForURL("**/explore");
      await shot("arrived");
      await page.getByRole("button", { name: "Menu" }).click();
      await shot("menu");
      await page.getByRole("button", { name: "Close menu" }).click();
      for (let i = 1; i <= 2; i += 1) {
        await page.getByRole("button", { name: "Skip" }).click();
        await page.getByRole("button", { name: "Skip" }).or(page.getByText("Time to head back")).first().waitFor({ timeout: 45000 });
        await shot(`skip-${i}`, { settle: 1500 });
      }
      for (let i = 0; i < 8; i += 1) {
        const here = page.getByRole("button", { name: "I’m here" });
        if (!(await here.isVisible().catch(() => false))) break;
        await here.click();
        await page.waitForTimeout(500);
      }
      await shot("head-back");
      await page.getByRole("button", { name: /finish walk/ }).click();
      await shot("done");
    },
    custom: {
      // Location granted, standing downtown.
      context: { permissions: ["geolocation"], geolocation: { latitude: 30.2684, longitude: -97.7427 } },
      run: async ({ page, shot }) => {
        await page.getByRole("button", { name: "Start exploring" }).click();
        await page.getByLabel("Search tastes").fill("Khruangbin");
        await shot("search", { settle: 1500 });
        await page.locator(".card button").first().click();
        await page.getByRole("button", { name: "Leon Bridges", exact: true }).click();
        await page.getByRole("button", { name: "Coffee", exact: true }).click();
        await shot("ready");
        await page.getByRole("button", { name: /Continue/ }).click();
        await shot("start", { settle: 1500 });
        await page.getByLabel(/What’s the vibe/).fill("live music, not too fancy");
        await shot("vibe");
        await page.getByRole("button", { name: /Pick a spot|Starting at your pin/ }).click();
        await shot("picker", { settle: 1500 });
        await page.getByRole("button", { name: "Start here" }).click();
        await page.getByRole("button", { name: "Build my route" }).click();
        await page.getByRole("button", { name: "I’m here" }).waitFor({ timeout: 45000 });
        await shot("plan");
      },
    },
    // A first-time user with location blocked: is there still a way forward?
    "no-location": {
      context: { permissions: [] },
      run: async ({ page, shot }) => {
        await page.getByRole("button", { name: "Start exploring" }).click();
        await page.getByRole("button", { name: "Leon Bridges", exact: true }).click();
        await page.getByRole("button", { name: "Khruangbin", exact: true }).click();
        await page.getByRole("button", { name: "Coffee", exact: true }).click();
        await page.getByRole("button", { name: /Continue/ }).click();
        await shot("start-denied", { settle: 2000 });
      },
    },
  },
};
