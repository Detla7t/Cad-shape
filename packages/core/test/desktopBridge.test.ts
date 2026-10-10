// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
    createBridgeServer,
    detectApps,
    expandPattern,
    parseAppSpec,
    safeFileName,
} from "../../../scripts/desktop-bridge.mjs";
import {
    canOpenOnDesktop,
    type DesktopBridgeInfo,
    desktopAppsFor,
    openOnDesktop,
    probeDesktopBridge,
    revealOnDesktop,
} from "../src";

interface Reply {
    readonly status: number;
    readonly body: string;
}

function request(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method: init.method ?? "GET", headers: init.headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () =>
                resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
            );
        });
        req.on("error", reject);
        if (init.body !== undefined) req.write(init.body);
        req.end();
    });
}

/** A fetch over node:http (the app's code path, without the DOM fetch's origin rules). */
async function nodeFetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
    const reply = await request(url, init);
    return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        json: async () => JSON.parse(reply.body),
    } as unknown as Response;
}

const FREECAD = {
    id: "freecad",
    name: "FreeCAD",
    extensions: ["step", "stp", "stl"],
    command: "/opt/freecad/bin/FreeCAD",
};
const ANY = { id: "editor", name: "Editor", extensions: null, command: "/usr/bin/editor" };

describe("desktop bridge server", () => {
    let dir: string;
    let exportsDir: string;
    let server: http.Server;
    let base: string;
    const launched: { file: string; app: unknown }[] = [];
    let failLaunch = false;

    beforeAll(async () => {
        dir = mkdtempSync(path.join(os.tmpdir(), "chili3d-desktop-bridge-"));
        exportsDir = path.join(dir, "exports");
        server = createBridgeServer({
            slicer: "chili3d-no-such-slicer-xyz",
            origins: ["https://cad.example"],
            log: () => {},
            detect: false,
            apps: [FREECAD, ANY],
            exportsDir,
            platform: "linux",
            launch: async (file, app) => {
                if (failLaunch) throw new Error("cannot run xdg-open: ENOENT");
                launched.push({ file, app });
            },
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(() => {
        launched.length = 0;
        failLaunch = false;
    });

    const post = (route: string, body: unknown) =>
        request(`${base}${route}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
        });
    const open = (name: string, content = "solid", app?: string) =>
        post("/open", { file: Buffer.from(content).toString("base64"), name, app });

    test("health lists the apps, the openable types and the exports folder; no slicer is not an error", async () => {
        const reply = await request(`${base}/health`);
        expect(reply.status).toBe(200);
        const body = JSON.parse(reply.body);
        expect(body).toMatchObject({
            ok: true,
            platform: "linux",
            exportsDir,
            apps: [FREECAD, ANY],
            slicer: "chili3d-no-such-slicer-xyz",
            version: null,
        });
        expect(body.openable).toContain("step");
        expect(body.openable).not.toContain("exe");
        expect(body.slicerError).toContain("cannot run chili3d-no-such-slicer-xyz");
    });

    test("open saves the file under the exports folder without overwriting and launches the default program", async () => {
        const first = await open("part.step", "ISO-10303-21;");
        expect(first.status).toBe(200);
        const body = JSON.parse(first.body) as {
            ok: boolean;
            path: string;
            app: { id: string; name: string };
        };
        expect(body.ok).toBe(true);
        expect(body.path).toBe(path.join(exportsDir, "part.step"));
        expect(readFileSync(body.path, "utf8")).toBe("ISO-10303-21;");
        expect(body.app).toEqual({ id: "default", name: "default app" });
        expect(launched).toEqual([{ file: body.path, app: "default" }]);

        const second = JSON.parse((await open("part.step", "second")).body) as { path: string };
        expect(second.path).toBe(path.join(exportsDir, "part (1).step"));
        expect(readFileSync(second.path, "utf8")).toBe("second");
        expect(readFileSync(body.path, "utf8")).toBe("ISO-10303-21;");
    });

    test("open with an app id launches that app; names never leave the folder", async () => {
        const reply = await open("../../escape.stl", "x", "freecad");
        expect(reply.status).toBe(200);
        const body = JSON.parse(reply.body) as { path: string; app: { id: string; name: string } };
        expect(body.path).toBe(path.join(exportsDir, "escape.stl"));
        expect(body.app).toEqual({ id: "freecad", name: "FreeCAD" });
        expect(launched).toEqual([{ file: body.path, app: FREECAD }]);
        expect(existsSync(path.join(dir, "escape.stl"))).toBe(false);
    });

    test("open refuses executables, unknown apps and bad bodies; a launch failure is reported", async () => {
        const exe = await open("tool.exe");
        expect(exe.status).toBe(415);
        expect(JSON.parse(exe.body).error).toContain('".exe"');
        expect(launched).toEqual([]);

        const unknown = await open("part.step", "x", "blender");
        expect(unknown.status).toBe(404);
        expect(JSON.parse(unknown.body).error).toContain('no app "blender"');

        expect((await post("/open", "{nope")).status).toBe(400);
        expect((await post("/open", { file: "AAAA" })).status).toBe(400);
        expect((await post("/open", { file: "AAAA", name: " " })).status).toBe(400);

        failLaunch = true;
        const failed = await open("part.step");
        expect(failed.status).toBe(500);
        const body = JSON.parse(failed.body) as { ok: boolean; error: string; path: string };
        expect(body.ok).toBe(false);
        expect(body.error).toContain("cannot run xdg-open");
        // The file was still saved.
        expect(existsSync(body.path)).toBe(true);
    });

    test("reveal shows a saved file in the file manager and nothing else", async () => {
        const saved = JSON.parse((await open("reveal-me.dxf", "0\nSECTION")).body) as { path: string };
        launched.length = 0;
        const reply = await post("/reveal", { path: saved.path });
        expect(reply.status).toBe(200);
        expect(launched).toEqual([{ file: saved.path, app: "reveal" }]);

        const elsewhere = path.join(dir, "outside.txt");
        writeFileSync(elsewhere, "x");
        expect((await post("/reveal", { path: elsewhere })).status).toBe(400);
        expect((await post("/reveal", { path: path.join(exportsDir, "missing.step") })).status).toBe(400);
        expect((await post("/reveal", {})).status).toBe(400);
    });

    test("the core client probes, opens and reveals through the same protocol", async () => {
        rs.stubGlobal("fetch", nodeFetch);
        try {
            const probed = await probeDesktopBridge(`${base}/`);
            expect(probed.isOk).toBe(true);
            const info = probed.value as DesktopBridgeInfo;
            expect(info.url).toBe(base);
            expect(info.platform).toBe("linux");
            expect(info.exportsDir).toBe(exportsDir);
            expect(info.apps).toEqual([FREECAD, ANY]);
            expect(info.slicer).toBeUndefined();
            expect(canOpenOnDesktop(info, "part.STEP")).toBe(true);
            expect(canOpenOnDesktop(info, "setup.exe")).toBe(false);
            expect(canOpenOnDesktop(info, "noextension")).toBe(false);
            expect(desktopAppsFor(info, "part.step").map((app) => app.id)).toEqual(["freecad", "editor"]);
            expect(desktopAppsFor(info, "plate.dxf").map((app) => app.id)).toEqual(["editor"]);
            expect(desktopAppsFor(info, "tool.exe")).toEqual([]);

            const opened = await openOnDesktop(
                base,
                { blob: new Blob(["solid x"]), name: "client.stl" },
                "freecad",
            );
            expect(opened.isOk).toBe(true);
            expect(opened.value).toEqual({
                path: path.join(exportsDir, "client.stl"),
                app: { id: "freecad", name: "FreeCAD" },
            });
            expect(readFileSync(path.join(exportsDir, "client.stl"), "utf8")).toBe("solid x");
            expect(launched.at(-1)).toEqual({ file: path.join(exportsDir, "client.stl"), app: FREECAD });

            const revealed = await revealOnDesktop(base, opened.value!.path);
            expect(revealed.isOk).toBe(true);
            expect(launched.at(-1)).toEqual({ file: path.join(exportsDir, "client.stl"), app: "reveal" });

            const refused = await openOnDesktop(base, { blob: new Blob(["x"]), name: "tool.exe" });
            expect(refused.isOk).toBe(false);
            expect(refused.error).toContain('".exe"');
        } finally {
            rs.unstubAllGlobals();
        }
    });

    test("an unreachable bridge is an error result", async () => {
        rs.stubGlobal("fetch", async () => {
            throw new TypeError("fetch failed");
        });
        try {
            const probed = await probeDesktopBridge("http://127.0.0.1:9");
            expect(probed.isOk).toBe(false);
            expect(probed.error).toContain("not reachable");
            const opened = await openOnDesktop("http://127.0.0.1:9", {
                blob: new Blob(["x"]),
                name: "a.step",
            });
            expect(opened.isOk).toBe(false);
            expect(opened.error).toContain("not reachable");
        } finally {
            rs.unstubAllGlobals();
        }
    });
});

describe("desktop bridge app detection", () => {
    let dir: string;
    beforeAll(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), "chili3d-detect-"));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    test("on Linux, executables on PATH and in the flatpak exports count; plain files do not", () => {
        const bin = path.join(dir, "bin");
        const home = path.join(dir, "home");
        mkdirSync(bin, { recursive: true });
        mkdirSync(path.join(home, ".local", "share", "flatpak", "exports", "bin"), { recursive: true });
        writeFileSync(path.join(bin, "freecad"), "#!/bin/sh\n");
        chmodSync(path.join(bin, "freecad"), 0o755);
        writeFileSync(path.join(bin, "prusa-slicer"), "not executable");
        chmodSync(path.join(bin, "prusa-slicer"), 0o644);
        const bambu = path.join(
            home,
            ".local",
            "share",
            "flatpak",
            "exports",
            "bin",
            "com.bambulab.BambuStudio",
        );
        writeFileSync(bambu, "#!/bin/sh\n");
        chmodSync(bambu, 0o755);
        const apps = detectApps({
            platform: "linux",
            env: { PATH: `${bin}:/nonexistent` },
            home,
            systemDirs: [path.join(dir, "no-system-flatpak")],
        });
        expect(apps.map((app) => [app.id, app.command])).toEqual([
            ["freecad", path.join(bin, "freecad")],
            ["bambustudio", bambu],
        ]);
        expect(apps[0].extensions).toContain("step");
    });

    test("on Windows, %ProgramFiles% patterns expand and the newest version wins", () => {
        const programFiles = path.join(dir, "Program Files");
        for (const version of ["FreeCAD 0.21", "FreeCAD 1.0"]) {
            mkdirSync(path.join(programFiles, version, "bin"), { recursive: true });
            writeFileSync(path.join(programFiles, version, "bin", "FreeCAD.exe"), "MZ");
        }
        mkdirSync(path.join(programFiles, "Prusa3D", "PrusaSlicer"), { recursive: true });
        writeFileSync(path.join(programFiles, "Prusa3D", "PrusaSlicer", "prusa-slicer.exe"), "MZ");
        const env = { PROGRAMFILES: programFiles, PATH: "" };
        expect(expandPattern("%ProgramFiles%\\FreeCAD*\\bin\\FreeCAD.exe", env)).toEqual([
            path.join(programFiles, "FreeCAD 1.0", "bin", "FreeCAD.exe"),
            path.join(programFiles, "FreeCAD 0.21", "bin", "FreeCAD.exe"),
        ]);
        expect(expandPattern("%LocalAppData%\\Programs\\x.exe", env)).toEqual([]);
        const apps = detectApps({ platform: "win32", env, home: dir });
        expect(apps.map((app) => [app.id, app.command])).toEqual([
            ["freecad", path.join(programFiles, "FreeCAD 1.0", "bin", "FreeCAD.exe")],
            ["prusaslicer", path.join(programFiles, "Prusa3D", "PrusaSlicer", "prusa-slicer.exe")],
        ]);
    });

    test("on macOS, bundles under ~/Applications count; user apps replace a known app of the same id", () => {
        const home = path.join(dir, "mac-home");
        mkdirSync(path.join(home, "Applications", "PrusaSlicer.app"), { recursive: true });
        const apps = detectApps({
            platform: "darwin",
            env: { PATH: "" },
            home,
            extra: [{ id: "prusaslicer", name: "PrusaSlicer (beta)", extensions: null, command: "/opt/ps" }],
        });
        expect(apps).toEqual([
            { id: "prusaslicer", name: "PrusaSlicer (beta)", extensions: null, command: "/opt/ps" },
        ]);
        expect(detectApps({ platform: "darwin", env: { PATH: "" }, home }).map((app) => app.command)).toEqual(
            [path.join(home, "Applications", "PrusaSlicer.app")],
        );
    });

    test("--app entries name a program with optional file types", () => {
        expect(parseAppSpec("Blender[stl, .OBJ]=/usr/bin/blender")).toEqual({
            id: "blender",
            name: "Blender",
            extensions: ["stl", "obj"],
            command: "/usr/bin/blender",
        });
        expect(parseAppSpec("My CAD = C:\\Program Files\\My CAD\\cad.exe")).toEqual({
            id: "my-cad",
            name: "My CAD",
            extensions: null,
            command: "C:\\Program Files\\My CAD\\cad.exe",
        });
        expect(() => parseAppSpec("nothing here")).toThrow("Name[ext,ext]=command");
    });

    test("saved names stay inside the folder and keep their extension", () => {
        expect(safeFileName("part.step")).toBe("part.step");
        expect(safeFileName("../../etc/passwd")).toBe("passwd");
        expect(safeFileName('a<b>:"c|d?*.dxf')).toBe("a_b___c_d__.dxf");
        expect(safeFileName("  .hidden.stl ")).toBe("hidden.stl");
        expect(safeFileName("")).toBe("export");
        expect(safeFileName(`${"x".repeat(200)}.step`)).toBe(`${"x".repeat(145)}.step`);
    });
});
