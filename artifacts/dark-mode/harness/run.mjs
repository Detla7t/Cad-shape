import fs from "node:fs";
import { audit, launch } from "./lib.mjs";

const theme = process.argv[2] || "dark";
const dir = process.argv[3] || `/tmp/dm/${theme}`;
fs.mkdirSync(dir, { recursive: true });
const { browser, page } = await launch(theme);
const report = {};
page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) console.log("NAV", f.url());
});
const esc = async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await page.mouse.click(700, 887);
    await page.waitForTimeout(200);
};
async function step(name, fn, keep = false) {
    try {
        await fn();
        await audit(page, name, dir, report);
    } catch (e) {
        console.log(`${name}: ERROR ${e.message.split("\n")[0]}`);
    }
    if (!keep) await esc().catch(() => {});
}
const clickTitle = (t) => page.locator(`[title="${t}"]:visible`).first().click();
await step("home", async () => {}, true);
await step("home-create-menu", () => page.getByText("Create▾").first().click());
await step(
    "home-new-document",
    async () => {
        await page.getByText("Create document…").last().click();
    },
    true,
);
await page.getByRole("button", { name: "Create document", exact: true }).click();
await page.waitForTimeout(3000);
await step("editor", async () => {});
for (const t of [
    "Choose toolset",
    "Sketch tools",
    "Solid features",
    "Edge treatments",
    "Part operations",
    "Patterns",
    "FeatureScript",
    "New Feature Studio tools",
]) {
    await step(`ribbon-${t.replace(/\W+/g, "_")}`, () => clickTitle(t));
}
await step("search-tools", async () => {
    await clickTitle("Search tools");
    await page.keyboard.type("ex");
});
await step("configuration-options", () => clickTitle("Configuration options"));
await step("edit-configurations", () => clickTitle("Edit configurations"), true);
await esc();
await esc();
await step("tree-context-menu", async () => {
    await page.getByText("Top", { exact: true }).first().click({ button: "right" });
});
await step("document-units", () => clickTitle("Document units and precision"));
await step("view-options", () =>
    page
        .locator('[title="View options"], :text("View options")')
        .first()
        .click({ force: true })
        .catch(async () => {
            await page.mouse.click(1410, 227);
        }),
);
await step("viewport-tool-measure", () => clickTitle("Show measure details"));
await step("analysis-tools", () => clickTitle("Show analysis tools"));
await step("mass-properties", () => clickTitle("Display mass and section properties"));
await step("main-menu", () => page.mouse.click(1417, 20));
await step("create-element", () => clickTitle("Create element"));
await step("tabs-browse", () => clickTitle("Tabs"));
await step("plus-button", () => page.mouse.click(1196, 20));
for (const t of ["Appearances", "Configurations", "Custom tables", "Inspection table", "Variable table"]) {
    await step(
        `rightpanel-${t.replace(/\W+/g, "_")}`,
        () => page.locator(`[title="${t}"]:visible`).last().click(),
        true,
    );
    await page
        .locator(`[title="${t}"]:visible`)
        .last()
        .click()
        .catch(() => {});
    await page.waitForTimeout(200);
}
await step("left-versions-or-comments", () => clickTitle("Comments"), true);
await clickTitle("Comments").catch(() => {});
await step("variable-dialog", () => clickTitle("Variable"));
await step("plane-feature", () => clickTitle("Plane"));
await esc();
await step("new-sketch", async () => {
    await clickTitle("New Sketch");
    await page.waitForTimeout(500);
    await page.getByText("Top", { exact: true }).first().click();
});
await step("sketch-dropdown", () => clickTitle("Sketch tools"));
await esc();
await esc();
await step("preferences", () => clickTitle("Preferences"), true);
const sections = await page.evaluate(() =>
    [
        ...document.querySelectorAll(
            "[class*=preferences] nav button, [class*=preferencesDialog] [class*=nav] *",
        ),
    ]
        .map((e) => e.textContent.trim())
        .filter(Boolean),
);
console.log("pref sections", sections);
for (const s of [...new Set(sections)].slice(0, 12)) {
    await step(
        `preferences-${s.replace(/\W+/g, "_")}`,
        () => page.locator("[class*=preferencesDialog]").getByText(s, { exact: true }).first().click(),
        true,
    );
}
await esc();
await step("customize", () => clickTitle("Customize tools and tabs"), true);
await esc();
fs.writeFileSync(`${dir}/contrast-report.json`, JSON.stringify(report, null, 1));
const total = Object.values(report).reduce((s, r) => s + r.failures.length, 0);
console.log("TOTAL", total);
await browser.close();
