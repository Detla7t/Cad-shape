import { chromium } from "/tmp/igems-web-test/node_modules/playwright-core/index.mjs";
export async function launch(theme = "dark") {
    const browser = await chromium.launch({
        executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1194/chrome-linux/chrome`,
    });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
    await ctx.routeWebSocket(/.*/, () => {});
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.accept());
    page.setDefaultTimeout(4000);
    page.on("pageerror", (e) => console.log("PAGEERR", e.message.slice(0, 200)));
    await page.goto("http://localhost:8081/");
    await page.waitForTimeout(4000);
    await page.evaluate((t) => {
        window.Chili3dCore.Config.instance.themeMode = t;
    }, theme);
    await page.waitForTimeout(300);
    return { browser, page };
}
export const contrastFn = () => {
    const parse = (s) => {
        const m = s.match(/rgba?\(([^)]+)\)/);
        if (!m) {
            const m2 = s.match(/color\(srgb ([^)]+)\)/);
            if (!m2) return null;
            const p = m2[1].replace("/", " ").split(/\s+/).filter(Boolean).map(Number);
            return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1];
        }
        const p = m[1]
            .split(/[ ,/]+/)
            .filter(Boolean)
            .map(Number);
        return [p[0], p[1], p[2], p[3] ?? 1];
    };
    const blend = (top, bot) => {
        const a = top[3];
        return [
            top[0] * a + bot[0] * (1 - a),
            top[1] * a + bot[1] * (1 - a),
            top[2] * a + bot[2] * (1 - a),
            1,
        ];
    };
    const lum = (c) => {
        const f = (v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a, b) => {
        const l1 = lum(a),
            l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const bgOf = (el) => {
        const layers = [];
        for (let e = el; e; e = e.parentElement || e.getRootNode?.().host) {
            if (!(e instanceof Element)) break;
            const cs = getComputedStyle(e);
            if (
                cs.backgroundImage &&
                cs.backgroundImage !== "none" &&
                !cs.backgroundImage.startsWith("url")
            ) {
                layers.push("img");
            }
            const c = parse(cs.backgroundColor);
            if (c && c[3] > 0) {
                layers.push(c);
                if (c[3] >= 0.99) break;
            }
        }
        if (layers.includes("img")) return null;
        let base = [255, 255, 255, 1];
        const root = parse(getComputedStyle(document.body).backgroundColor);
        if (!layers.length || layers[layers.length - 1][3] < 0.99)
            base = root && root[3] > 0 ? root : [255, 255, 255, 1];
        let acc = base;
        for (let i = layers.length - 1; i >= 0; i--) acc = blend(layers[i], acc);
        return acc;
    };
    const out = [];
    const visit = (rootNode) => {
        const all = rootNode.querySelectorAll("*");
        for (const el of all) {
            if (el.shadowRoot) visit(el.shadowRoot);
            if (["SCRIPT", "STYLE", "CANVAS", "svg", "OPTION"].includes(el.tagName)) continue;
            const hasText =
                [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) ||
                (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) && (el.value || el.placeholder));
            if (!hasText) continue;
            const r = el.getBoundingClientRect();
            if (
                r.width < 2 ||
                r.height < 2 ||
                r.bottom < 0 ||
                r.right < 0 ||
                r.top > innerHeight ||
                r.left > innerWidth
            )
                continue;
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none") continue;
            let op = 1;
            for (let e = el; e instanceof Element; e = e.parentElement)
                op *= Number(getComputedStyle(e).opacity);
            if (op < 0.05) continue;
            // topmost check: is element actually visible at its center
            const cx = r.left + Math.min(r.width / 2, 20),
                cy = r.top + r.height / 2;
            const hit = document.elementFromPoint(cx, cy);
            if (hit && !(el.contains(hit) || hit.contains(el)) && !(el.getRootNode() !== document)) {
                // covered by something else (overlay); skip
                let host = hit;
                let ok = false;
                while (host) {
                    if (host === el) {
                        ok = true;
                        break;
                    }
                    host = host.parentElement;
                }
                if (!ok) continue;
            }
            const bg = bgOf(el);
            if (!bg) continue;
            let fg = parse(cs.color);
            if (!fg) continue;
            fg = blend([fg[0], fg[1], fg[2], fg[3] * op], bg);
            const rat = ratio(fg, bg);
            const size = parseFloat(cs.fontSize),
                bold = Number(cs.fontWeight) >= 700;
            const large = size >= 24 || (bold && size >= 18.66);
            const disabled =
                el.disabled || el.closest?.("[disabled]") || el.getAttribute("aria-disabled") === "true";
            const need = disabled ? 2 : large ? 3 : 4.5;
            const text = (
                el.value ||
                el.placeholder ||
                [...el.childNodes]
                    .filter((n) => n.nodeType === 3)
                    .map((n) => n.textContent)
                    .join(" ")
            )
                .trim()
                .slice(0, 40);
            if (rat < need)
                out.push({
                    text,
                    ratio: Math.round(rat * 100) / 100,
                    color: cs.color,
                    bg: `rgb(${bg.slice(0, 3).map(Math.round).join(",")})`,
                    cls: (typeof el.className === "string" ? el.className : "").slice(0, 60),
                    tag: el.tagName,
                    disabled: !!disabled,
                });
        }
    };
    visit(document);
    // native select checks
    for (const s of document.querySelectorAll("select")) {
        const cs = getComputedStyle(s);
        const o = s.options[0];
        if (!o) continue;
        const ocs = getComputedStyle(o);
        const scheme = cs.colorScheme;
        if (s.getBoundingClientRect().width > 0)
            out.push({
                select: true,
                text: o.textContent.slice(0, 30),
                optionColor: ocs.color,
                optionBg: ocs.backgroundColor,
                colorScheme: scheme,
            });
    }
    return out;
};
export async function audit(page, name, dir, report) {
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${name}.png` });
    const res = await page.evaluate(contrastFn);
    const fails = res.filter((r) => !r.select);
    const sels = res.filter((r) => r.select);
    report[name] = { failures: fails, selects: sels };
    console.log(`${name}: ${fails.length} low-contrast, ${sels.length} selects`);
    return res;
}
