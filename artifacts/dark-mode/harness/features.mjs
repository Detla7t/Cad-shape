import fs from "node:fs";
import { audit, launch } from "./lib.mjs";

const theme = process.argv[2] || "dark";
const dir = process.argv[3] || `/tmp/dm/${theme}`;
fs.mkdirSync(dir, { recursive: true });
const { browser, page } = await launch(theme);
const report = {};
const esc = async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.mouse.click(700, 887);
    await page.waitForTimeout(200);
};
async function step(name, fn, keep = false) {
    try {
        await fn();
        await page.waitForTimeout(600);
        await audit(page, name, dir, report);
    } catch (e) {
        console.log(`${name}: ERROR ${e.message.split("\n")[0]}`);
    }
    if (!keep) await esc().catch(() => {});
}
const clickTitle = (t) => page.locator(`[title="${t}"]:visible`).first().click();
await page.getByText("Create document…").last().click();
await page.getByRole("button", { name: "Create document", exact: true }).click();
await page.waitForTimeout(3000);
for (const t of [
    "Extrude",
    "Fillet",
    "Boolean",
    "Linear pattern",
    "Custom Feature",
    "Plane",
    "Variable",
    "Configuration",
]) {
    await step(`feature-${t.replace(/\W+/g, "_")}`, () => clickTitle(t));
    await esc().catch(() => {});
}
// solid features dropdown entries
await clickTitle("Solid features").catch(() => {});
const items = await page.evaluate(() =>
    [...document.querySelectorAll("[role=menuitem], [class*=menu] button")]
        .filter((e) => e.getBoundingClientRect().width > 0)
        .map((e) => e.textContent.trim())
        .filter(Boolean),
);
console.log("solid items", items);
await esc();
for (const label of ["Loft", "Revolve"]) {
    await step(`feature-${label}`, async () => {
        await clickTitle("Solid features").catch(() => clickTitle("Edge treatments"));
        await page
            .locator("[role=menuitem]:visible, [class*=menu] button:visible")
            .filter({ hasText: label })
            .first()
            .click();
    });
    await esc().catch(() => {});
}
await step("feature-Shell2", async () => {
    await clickTitle("Edge treatments");
    await page
        .locator("[role=menuitem]:visible, [class*=menu] button:visible")
        .filter({ hasText: "Shell" })
        .first()
        .click();
});
await esc();
await step(
    "new-sketch-panel",
    async () => {
        await clickTitle("New Sketch");
        await page.waitForTimeout(400);
        await page.getByText("Top", { exact: true }).first().click();
        await page.waitForTimeout(800);
    },
    true,
);
await step(
    "sketch-context-menu",
    async () => {
        await page.mouse.click(860, 460, { button: "right" });
    },
    true,
);
await esc();
await step("sketch-dropdown", () => clickTitle("Sketch tools"), true);
fs.writeFileSync(`${dir}/contrast-report-features.json`, JSON.stringify(report, null, 1));
console.log(
    "TOTAL",
    Object.values(report).reduce((s, r) => s + r.failures.length, 0),
);
await browser.close();
