// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, defaultUserPreferences, download } from "@chili3d/core";
import { rs } from "@rstest/core";
// The test locale is the identity: translated text is the key with its arguments substituted.
import { ExportDelivery } from "../src/desktop/exportDelivery";
import { Toast } from "../src/toast";

const INFO = {
    ok: true,
    platform: "linux",
    exportsDir: "/home/me/Downloads",
    openable: ["step", "stl", "dxf"],
    apps: [
        { id: "freecad", name: "FreeCAD", extensions: ["step", "stl"], command: "/usr/bin/freecad" },
        { id: "prusaslicer", name: "PrusaSlicer", extensions: ["stl"], command: "/usr/bin/prusa-slicer" },
    ],
    slicer: "prusa-slicer",
    version: null,
};

interface Call {
    readonly url: string;
    readonly body?: Record<string, unknown>;
}

/** A fake bridge: answers /health with INFO, saves nothing, records every call. */
function fakeBridge(options: { reachable?: boolean } = {}) {
    const calls: Call[] = [];
    rs.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
        if (options.reachable === false) throw new TypeError("fetch failed");
        const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
        calls.push({ url, body });
        const answer = (status: number, json: unknown) =>
            ({ ok: status < 300, status, json: async () => json }) as unknown as Response;
        if (url.endsWith("/health")) return answer(200, INFO);
        if (url.endsWith("/open")) {
            if (body?.["app"] === "broken") return answer(500, { ok: false, error: "cannot run broken" });
            const app = body?.["app"] === "default" ? { id: "default", name: "default app" } : INFO.apps[0];
            return answer(200, { ok: true, path: `/home/me/Downloads/${body?.["name"]}`, app });
        }
        if (url.endsWith("/reveal")) return answer(200, { ok: true, path: body?.["path"] });
        return answer(404, { ok: false, error: "no" });
    });
    return calls;
}

const toast = () => document.querySelector<HTMLElement>("[data-toast]");
const buttons = () => [...(toast()?.querySelectorAll("button") ?? [])];
const labels = () => buttons().map((button) => button.textContent);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const saved = Config.instance.preferences;
function preferences(openExports: boolean) {
    Config.instance.preferences = {
        ...defaultUserPreferences(),
        desktop: { bridgeUrl: "http://bridge.test:7781/", openExports },
    };
}

afterEach(() => {
    rs.unstubAllGlobals();
    Toast.dismiss();
    Config.instance.preferences = saved;
});

test("after a browser download the toast offers the default program and the bridge's apps for the type", async () => {
    preferences(false);
    const calls = fakeBridge();
    const delivery = new ExportDelivery();
    const taken = await delivery.deliver({ blob: new Blob(["ISO-10303-21;"]), name: "bracket.step" });
    expect(taken).toBe(false);
    expect(calls.map((call) => call.url)).toEqual(["http://bridge.test:7781/health"]);
    expect(toast()?.querySelector("span")?.textContent).toBe("toast.export.downloadedbracket.step");
    expect(labels()).toEqual(["export.openInDefaultApp", "export.openInFreeCAD", "×"]);

    buttons()[1].click();
    await settle();
    const open = calls.at(-1)!;
    expect(open.url).toBe("http://bridge.test:7781/open");
    expect(open.body).toEqual({ file: btoa("ISO-10303-21;"), name: "bracket.step", app: "freecad" });
    expect(toast()?.querySelector("span")?.textContent).toBe("toast.export.openedInbracket.stepFreeCAD");
    expect(labels()).toEqual(["export.showInFolder", "×"]);

    buttons()[0].click();
    await settle();
    expect(calls.at(-1)).toEqual({
        url: "http://bridge.test:7781/reveal",
        body: { path: "/home/me/Downloads/bracket.step" },
    });
});

test("an STL lists both slicer-capable apps; the probe is cached across exports", async () => {
    preferences(false);
    const calls = fakeBridge();
    const delivery = new ExportDelivery();
    await delivery.deliver({ blob: new Blob(["solid"]), name: "a.stl" });
    expect(labels()).toEqual([
        "export.openInDefaultApp",
        "export.openInFreeCAD",
        "export.openInPrusaSlicer",
        "×",
    ]);
    await delivery.deliver({ blob: new Blob(["solid"]), name: "b.stl" });
    expect(calls.filter((call) => call.url.endsWith("/health"))).toHaveLength(1);
    delivery.refresh();
    await delivery.deliver({ blob: new Blob(["solid"]), name: "c.stl" });
    expect(calls.filter((call) => call.url.endsWith("/health"))).toHaveLength(2);
});

test("with the preference on, the bridge takes the export and the default program opens it", async () => {
    preferences(true);
    const calls = fakeBridge();
    const delivery = new ExportDelivery();
    const taken = await delivery.deliver({ blob: new Blob(["solid"]), name: "part.stl" });
    expect(taken).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
        "http://bridge.test:7781/health",
        "http://bridge.test:7781/open",
    ]);
    expect(calls[1].body).toEqual({ file: btoa("solid"), name: "part.stl", app: "default" });
    expect(toast()?.querySelector("span")?.textContent).toBe(
        "toast.export.openedInpart.stlexport.defaultApp",
    );
    expect(labels()).toEqual(["export.showInFolder", "×"]);
});

test("types the bridge does not open, and an unreachable bridge, leave the plain browser download", async () => {
    preferences(true);
    fakeBridge();
    const delivery = new ExportDelivery();
    expect(await delivery.deliver({ blob: new Blob(["PK"]), name: "doc.chili3d" })).toBe(false);
    expect(toast()).toBeNull();

    rs.unstubAllGlobals();
    fakeBridge({ reachable: false });
    const offline = new ExportDelivery();
    expect(await offline.deliver({ blob: new Blob(["x"]), name: "part.step" })).toBe(false);
    expect(toast()).toBeNull();
});

test("a bridge failure while opening falls back to the download and says why", async () => {
    preferences(true);
    const calls = fakeBridge();
    // The fake answers 500 for the "broken" app; make the default route fail by swapping the apps.
    rs.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url.endsWith("/health"))
            return { ok: true, status: 200, json: async () => INFO } as unknown as Response;
        return {
            ok: false,
            status: 500,
            json: async () => ({ ok: false, error: "cannot run xdg-open: ENOENT" }),
        } as unknown as Response;
    });
    const delivery = new ExportDelivery();
    expect(await delivery.deliver({ blob: new Blob(["x"]), name: "part.step" })).toBe(false);
    expect(toast()?.dataset["toast"]).toBe("error");
    expect(toast()?.textContent).toBe("toast.export.openFailedcannot run xdg-open: ENOENT");
});

test("installed, download() goes through the delivery and falls back to the browser when declined", async () => {
    preferences(false);
    fakeBridge({ reachable: false });
    const clicks: string[] = [];
    const click = rs.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
    ) {
        clicks.push(this.download);
    });
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = () => "blob:mock";
    URL.revokeObjectURL = () => {};
    const delivery = new ExportDelivery();
    const uninstall = delivery.install();
    try {
        download(["x"], "fallback.step");
        await settle();
        expect(clicks).toEqual(["fallback.step"]);
    } finally {
        uninstall();
        click.mockRestore();
        URL.createObjectURL = createObjectURL;
        URL.revokeObjectURL = revokeObjectURL;
    }
});
