#!/usr/bin/env node
// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Chili3d's local desktop bridge: a small HTTP server on this machine that lets the browser app
 * reach the desktop. It saves exported files into a folder and opens them in a desktop program —
 * the system's default program for the file type, or one the bridge found (FreeCAD, PrusaSlicer,
 * Bambu Studio, OrcaSlicer, Cura, LibreCAD, QCAD, Inkscape, MeshLab, LightBurn, CAMotics, Rhino,
 * SOLIDWORKS) — reveals saved files in the file manager, and slices with an installed PrusaSlicer
 * for the CAM Studio.
 *
 *   node scripts/desktop-bridge.mjs [--port 7781] [--host 127.0.0.1] [--exports ~/Downloads]
 *        [--app "Name[ext,ext]=command"]... [--allow ext,ext] [--no-detect]
 *        [--slicer /path/to/prusa-slicer] [--origin https://your.chili3d.host]... [--timeout 600]
 *
 * Environment: CHILI3D_BRIDGE_PORT, CHILI3D_ORIGINS (comma-separated extra allowed origins),
 * CHILI3D_EXPORTS_DIR, CHILI3D_APPS (";"-separated `Name[ext,ext]=command` entries),
 * CHILI3D_ALLOW (comma-separated extra openable extensions), PRUSA_SLICER (slicer executable).
 * The app's dev server origins (localhost / 127.0.0.1 on ports 8080 and 8081) are always
 * allowed; requests without an Origin header (curl) are accepted; other browser origins are refused.
 *
 * Protocol (JSON bodies and answers):
 *   GET  /health → { ok, platform, exportsDir, openable: [ext], apps: [{ id, name, extensions, command }],
 *                    slicer, version, slicerError? }       (version is null without a working PrusaSlicer)
 *   POST /open   { file: <base64>, name: "part.step", app?: "default" | <app id> }
 *              → { ok: true, path, app: { id, name } } | { ok: false, error }
 *   POST /reveal { path }  (a file the bridge saved) → shows it in the file manager
 *   POST /slice  { model: <base64 3MF or STL>, modelName: "job.3mf", config: <INI text>, arrange?: boolean }
 *              → { ok: true, gcode, log } | { ok: false, error, log }
 *
 * /open writes the file under the exports folder (a browser-style " (1)" suffix avoids
 * overwriting) and launches the program detached; only the listed file types open (`--allow`
 * adds more) — never executables. A slice writes the model and the INI into a fresh temporary
 * directory, runs
 *   prusa-slicer --export-gcode [--dont-arrange] --load job.ini --output job.gcode job.3mf
 * (always ASCII G-code: `binary_gcode = 0` is appended to the INI), returns the G-code and
 * removes the directory. Jobs run one at a time. The server listens on 127.0.0.1 only.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_PORT = 7781;
export const DEFAULT_ORIGINS = [
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://localhost:8081",
    "http://127.0.0.1:8081",
];
const MAX_BODY_BYTES = 512 * 1024 * 1024;
const MODEL_EXTENSIONS = new Set(["3mf", "stl", "obj", "amf"]);

/** File types the bridge opens by default: CAD, meshes, drawings, programs, documents — no executables. */
export const DEFAULT_OPENABLE = [
    "step",
    "stp",
    "iges",
    "igs",
    "brep",
    "brp",
    "stl",
    "ply",
    "obj",
    "3mf",
    "amf",
    "off",
    "gltf",
    "glb",
    "3dm",
    "dxf",
    "dwg",
    "svg",
    "pdf",
    "png",
    "jpg",
    "jpeg",
    "csv",
    "txt",
    "md",
    "json",
    "ini",
    "nc",
    "gcode",
    "bgcode",
    "ngc",
    "tap",
    "cnc",
    "zip",
];

/**
 * @typedef {object} KnownApp
 * @property {string} id
 * @property {string} name
 * @property {string[] | null} extensions File types it opens (lower-case, no dot); null = any.
 * @property {string[]} [linux] Executable names looked up on PATH and in the flatpak export bins.
 * @property {string[]} [mac] Bundle names under /Applications and ~/Applications.
 * @property {string[]} [win] Paths with %Var% expansions and one `*` per segment.
 */

/** Desktop programs the bridge looks for; each is launched as `command <file>` (`open -a` for bundles). */
export const KNOWN_APPS = [
    {
        id: "freecad",
        name: "FreeCAD",
        extensions: [
            "step",
            "stp",
            "iges",
            "igs",
            "brep",
            "brp",
            "stl",
            "ply",
            "obj",
            "3mf",
            "amf",
            "off",
            "dxf",
            "svg",
            "gltf",
            "glb",
        ],
        linux: ["freecad", "FreeCAD", "freecad-daily", "org.freecad.FreeCAD", "org.freecadweb.FreeCAD"],
        mac: ["FreeCAD.app"],
        win: [
            "%ProgramFiles%\\FreeCAD*\\bin\\FreeCAD.exe",
            "%LocalAppData%\\Programs\\FreeCAD*\\bin\\FreeCAD.exe",
        ],
    },
    {
        id: "prusaslicer",
        name: "PrusaSlicer",
        extensions: ["stl", "3mf", "obj", "amf", "step", "stp", "gcode", "bgcode"],
        linux: ["prusa-slicer", "PrusaSlicer", "com.prusa3d.PrusaSlicer"],
        mac: ["PrusaSlicer.app", "Original Prusa Drivers/PrusaSlicer.app"],
        win: ["%ProgramFiles%\\Prusa3D\\PrusaSlicer\\prusa-slicer.exe"],
    },
    {
        id: "bambustudio",
        name: "Bambu Studio",
        extensions: ["stl", "3mf", "obj", "amf", "step", "stp", "gcode"],
        linux: ["bambu-studio", "BambuStudio", "com.bambulab.BambuStudio"],
        mac: ["BambuStudio.app"],
        win: ["%ProgramFiles%\\Bambu Studio\\bambu-studio.exe"],
    },
    {
        id: "orcaslicer",
        name: "OrcaSlicer",
        extensions: ["stl", "3mf", "obj", "amf", "step", "stp", "gcode"],
        linux: ["orca-slicer", "OrcaSlicer", "io.github.softfever.OrcaSlicer"],
        mac: ["OrcaSlicer.app"],
        win: ["%ProgramFiles%\\OrcaSlicer\\orca-slicer.exe"],
    },
    {
        id: "cura",
        name: "UltiMaker Cura",
        extensions: ["stl", "3mf", "obj", "ply", "gltf", "glb", "gcode"],
        linux: ["cura", "UltiMaker-Cura", "com.ultimaker.cura"],
        mac: ["UltiMaker Cura.app", "Ultimaker Cura.app"],
        win: [
            "%ProgramFiles%\\UltiMaker Cura*\\UltiMaker-Cura.exe",
            "%ProgramFiles%\\Ultimaker Cura*\\Ultimaker-Cura.exe",
        ],
    },
    {
        id: "librecad",
        name: "LibreCAD",
        extensions: ["dxf"],
        linux: ["librecad", "org.librecad.librecad"],
        mac: ["LibreCAD.app"],
        win: ["%ProgramFiles%\\LibreCAD\\LibreCAD.exe", "%ProgramFiles(x86)%\\LibreCAD\\LibreCAD.exe"],
    },
    {
        id: "qcad",
        name: "QCAD",
        extensions: ["dxf", "dwg"],
        linux: ["qcad"],
        mac: ["QCAD.app"],
        win: ["%ProgramFiles%\\QCAD*\\qcad.exe"],
    },
    {
        id: "inkscape",
        name: "Inkscape",
        extensions: ["svg", "dxf", "pdf", "png"],
        linux: ["inkscape", "org.inkscape.Inkscape"],
        mac: ["Inkscape.app"],
        win: ["%ProgramFiles%\\Inkscape\\bin\\inkscape.exe"],
    },
    {
        id: "meshlab",
        name: "MeshLab",
        extensions: ["stl", "ply", "obj", "off", "3mf", "gltf", "glb"],
        linux: ["meshlab", "net.meshlab.MeshLab"],
        mac: ["MeshLab.app", "MeshLab2023.12.app"],
        win: ["%ProgramFiles%\\VCG\\MeshLab\\meshlab.exe"],
    },
    {
        id: "lightburn",
        name: "LightBurn",
        extensions: ["svg", "dxf"],
        linux: ["LightBurn", "lightburn"],
        mac: ["LightBurn.app"],
        win: ["%ProgramFiles%\\LightBurn\\LightBurn.exe"],
    },
    {
        id: "camotics",
        name: "CAMotics",
        extensions: ["nc", "gcode", "ngc", "tap", "cnc"],
        linux: ["camotics"],
        mac: ["CAMotics.app"],
        win: ["%ProgramFiles%\\CAMotics\\camotics.exe"],
    },
    {
        id: "rhino",
        name: "Rhino",
        extensions: ["3dm", "step", "stp", "iges", "igs", "stl", "obj", "ply", "dxf", "dwg", "svg", "3mf"],
        mac: ["Rhino 8.app", "Rhino 7.app", "Rhinoceros.app"],
        win: ["%ProgramFiles%\\Rhino *\\System\\Rhino.exe"],
    },
    {
        id: "solidworks",
        name: "SOLIDWORKS",
        extensions: ["step", "stp", "iges", "igs", "stl", "3mf", "dxf", "dwg"],
        win: ["%ProgramFiles%\\SOLIDWORKS Corp\\SOLIDWORKS\\SLDWORKS.exe"],
    },
];

const isDirectory = (p) => {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
};
const isFile = (p) => {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
};
const isExecutable = (p) => {
    if (!isFile(p)) return false;
    try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
};

/** Case-insensitive environment lookup (Windows variable names are case-insensitive). */
function envValue(env, name) {
    if (env[name] !== undefined) return env[name];
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : env[key];
}

/**
 * Existing paths matching a Windows-style pattern: `%Var%` expands from `env`, a segment may hold
 * `*`. Matches come newest-name first (`FreeCAD 1.0` before `FreeCAD 0.21`).
 * @param {string} pattern
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function expandPattern(pattern, env) {
    let missing = false;
    const expanded = pattern.replace(/%([^%]+)%/g, (_, name) => {
        const value = envValue(env, name);
        if (value === undefined || value === "") missing = true;
        return value ?? "";
    });
    if (missing) return [];
    const parts = expanded.split(/[\\/]+/);
    const first = parts.shift() ?? "";
    let bases = [first === "" ? path.sep : /^[A-Za-z]:$/.test(first) ? `${first}${path.sep}` : first];
    for (const segment of parts) {
        if (segment === "") continue;
        if (!segment.includes("*")) {
            bases = bases.map((base) => path.join(base, segment));
            continue;
        }
        const pattern = new RegExp(
            `^${segment
                .split("*")
                .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                .join(".*")}$`,
            "i",
        );
        const next = [];
        for (const base of bases) {
            let entries = [];
            try {
                entries = fs.readdirSync(base);
            } catch {
                continue;
            }
            entries
                .filter((entry) => pattern.test(entry))
                .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
                .forEach((entry) => next.push(path.join(base, entry)));
        }
        bases = next;
        if (bases.length === 0) break;
    }
    return bases.filter((p) => fs.existsSync(p));
}

/**
 * The command that launches a known app on this machine, or undefined when it is not installed.
 * @param {KnownApp} app
 */
function findApp(app, { platform, env, home, systemDirs }) {
    if (platform === "win32") {
        for (const pattern of app.win ?? []) {
            const hit = expandPattern(pattern, env).find(isFile);
            if (hit) return hit;
        }
        return undefined;
    }
    if (platform === "darwin") {
        for (const bundle of app.mac ?? []) {
            for (const dir of ["/Applications", path.join(home, "Applications")]) {
                const candidate = path.join(dir, bundle);
                if (isDirectory(candidate)) return candidate;
            }
        }
    }
    const dirs = String(envValue(env, "PATH") ?? "")
        .split(path.delimiter)
        .filter(Boolean);
    if (platform === "linux") {
        // Flatpak apps are not on PATH; their exported launchers are real executables.
        dirs.push(path.join(home, ".local", "share", "flatpak", "exports", "bin"), ...systemDirs);
    }
    for (const name of app.linux ?? []) {
        for (const dir of dirs) {
            const candidate = path.join(dir, name);
            if (isExecutable(candidate)) return candidate;
        }
    }
    return undefined;
}

/**
 * The known apps installed on this machine (`{ id, name, extensions, command }`), followed by
 * `extra` apps (a user's `--app` entries replace a known app of the same id).
 * @param {{ platform?: string, env?: Record<string, string | undefined>, home?: string, extra?: DetectedApp[], known?: KnownApp[], systemDirs?: string[] }} [options]
 * @returns {DetectedApp[]}
 * @typedef {{ id: string, name: string, extensions: string[] | null, command: string }} DetectedApp
 */
export function detectApps({
    platform = process.platform,
    env = process.env,
    home = os.homedir(),
    extra = [],
    known = KNOWN_APPS,
    systemDirs = ["/var/lib/flatpak/exports/bin"],
} = {}) {
    const apps = new Map();
    for (const app of known) {
        const command = findApp(app, { platform, env, home, systemDirs });
        if (command) apps.set(app.id, { id: app.id, name: app.name, extensions: app.extensions, command });
    }
    for (const app of extra) apps.set(app.id, app);
    return [...apps.values()];
}

/**
 * Parses a `--app` entry: `Name=command` (opens any file type) or `Name[ext,ext]=command`.
 * @param {string} spec
 * @returns {DetectedApp}
 */
export function parseAppSpec(spec) {
    const match = /^\s*([^[=]+?)\s*(?:\[([^\]]*)\])?\s*=\s*(.+?)\s*$/.exec(spec);
    if (!match) throw new Error(`cannot read app "${spec}": expected Name[ext,ext]=command`);
    const [, name, extensions, command] = match;
    const id = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    if (!id) throw new Error(`cannot read app "${spec}": the name is empty`);
    return {
        id,
        name,
        extensions:
            extensions === undefined
                ? null
                : extensions
                      .split(",")
                      .map((ext) => ext.trim().replace(/^\./, "").toLowerCase())
                      .filter(Boolean),
        command,
    };
}

/** Where exports go without `--exports`: the Downloads folder, or a chili3d folder in the temp dir. */
export function defaultExportsDir(home = os.homedir()) {
    const downloads = path.join(home, "Downloads");
    return isDirectory(downloads) ? downloads : path.join(os.tmpdir(), "chili3d-exports");
}

/** A file name the exports folder accepts: no directories, no control or reserved characters. */
export function safeFileName(name) {
    const base = String(name).split(/[\\/]/).pop() ?? "";
    const clean = [...base]
        .map((char) => (char.charCodeAt(0) < 32 || '<>:"|?*'.includes(char) ? "_" : char))
        .join("")
        .trim()
        .replace(/^\.+/, "");
    const extension = path.extname(clean);
    let stem = clean.slice(0, clean.length - extension.length) || "export";
    if (stem.length + extension.length > 150) stem = stem.slice(0, 150 - extension.length);
    return `${stem}${extension}`;
}

/** Writes the file into `dir` without overwriting: `part.step`, `part (1).step`, … Resolves with the path. */
export async function saveExport(dir, name, bytes) {
    await mkdir(dir, { recursive: true });
    const safe = safeFileName(name);
    const extension = path.extname(safe);
    const stem = safe.slice(0, safe.length - extension.length);
    for (let i = 0; ; i++) {
        const candidate = path.join(dir, i === 0 ? safe : `${stem} (${i})${extension}`);
        try {
            await writeFile(candidate, bytes, { flag: "wx" });
            return candidate;
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
    }
}

function spawnDetached(command, args) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
        } catch (error) {
            reject(error);
            return;
        }
        child.once("error", (error) => reject(new Error(`cannot run ${command}: ${error.message}`)));
        child.once("spawn", () => {
            child.unref();
            resolve(undefined);
        });
    });
}

/**
 * Opens `filePath` on the desktop: with the system's default program (`app` "default"), in the
 * file manager (`app` "reveal"), or with a detected app. Resolves once the program was started.
 * @param {string} filePath
 * @param {"default" | "reveal" | DetectedApp} app
 * @param {{ platform?: string }} [options]
 */
export function launchFile(filePath, app, { platform = process.platform } = {}) {
    if (app === "reveal") {
        if (platform === "darwin") return spawnDetached("open", ["-R", filePath]);
        if (platform === "win32") return spawnDetached("explorer.exe", [`/select,${filePath}`]);
        return spawnDetached("xdg-open", [path.dirname(filePath)]);
    }
    if (app === "default") {
        if (platform === "darwin") return spawnDetached("open", [filePath]);
        if (platform === "win32") return spawnDetached("cmd.exe", ["/c", "start", "", filePath]);
        return spawnDetached("xdg-open", [filePath]);
    }
    if (platform === "darwin" && app.command.endsWith(".app")) {
        return spawnDetached("open", ["-a", app.command, filePath]);
    }
    return spawnDetached(app.command, [filePath]);
}

/** The slicer to run: an executable path, or { command, args } (args come first). */
function slicerCommand(slicer) {
    if (typeof slicer === "string") return { command: slicer, args: [] };
    return { command: slicer.command, args: slicer.args ?? [] };
}

function describeSlicer(slicer) {
    const { command, args } = slicerCommand(slicer);
    return [command, ...args].join(" ");
}

/** Runs the slicer; resolves with its exit code and output (never rejects). */
export function runSlicer(slicer, args, { timeoutMs = 600_000 } = {}) {
    const { command, args: prefix } = slicerCommand(slicer);
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, ...result });
        };
        let child;
        try {
            child = spawn(command, [...prefix, ...args], {
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
        } catch (error) {
            finish({ code: -1, error: error.message });
            return;
        }
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish({ code: -1, error: `timed out after ${Math.round(timeoutMs / 1000)} s` });
        }, timeoutMs);
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", (error) => finish({ code: -1, error: error.message }));
        child.on("close", (code) => finish({ code: code ?? -1 }));
    });
}

/** Slices one job; resolves with { ok, gcode?, error?, log }. */
export async function sliceJob({ slicer, model, modelName = "job.3mf", config, arrange = false, timeoutMs }) {
    const extension = path.extname(String(modelName)).slice(1).toLowerCase() || "3mf";
    if (!MODEL_EXTENSIONS.has(extension)) {
        return { ok: false, error: `unsupported model type ".${extension}"`, log: "" };
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "chili3d-prusa-"));
    try {
        const modelPath = path.join(dir, `job.${extension}`);
        const iniPath = path.join(dir, "job.ini");
        const outPath = path.join(dir, "job.gcode");
        await writeFile(modelPath, model);
        // PrusaSlicer refuses an INI with a repeated key: replace the job's own setting.
        const ini = String(config)
            .replace(/^[ \t]*binary_gcode[ \t]*=.*$/gm, "")
            .trimEnd();
        await writeFile(iniPath, `${ini}\n# the bridge returns text G-code\nbinary_gcode = 0\n`);
        const args = [
            "--export-gcode",
            ...(arrange ? [] : ["--dont-arrange"]),
            "--load",
            iniPath,
            "--output",
            outPath,
            modelPath,
        ];
        const run = await runSlicer(slicer, args, { timeoutMs });
        const log = `${run.stdout}${run.stderr}`;
        if (run.code !== 0) {
            return { ok: false, error: run.error ?? `prusa-slicer exited with code ${run.code}`, log };
        }
        let gcode;
        try {
            gcode = await readFile(outPath, "utf8");
        } catch {
            return { ok: false, error: "prusa-slicer wrote no G-code", log };
        }
        return { ok: true, gcode, log };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function readBody(request, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on("data", (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(Object.assign(new Error("request too large"), { status: 413 }));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => resolve(Buffer.concat(chunks)));
        request.on("error", reject);
    });
}

async function readJson(request, limit) {
    try {
        return { body: JSON.parse((await readBody(request, limit)).toString("utf8")) };
    } catch (error) {
        return { status: error.status ?? 400, error: error.status ? error.message : "the body is not JSON" };
    }
}

/** True when `filePath` lies inside `dir` (so /reveal only shows what the bridge saved). */
function isInside(dir, filePath) {
    const relative = path.relative(path.resolve(dir), path.resolve(filePath));
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * @typedef {string | { command: string, args?: string[] }} SlicerCommand
 * @typedef {object} BridgeOptions
 * @property {SlicerCommand} [slicer] The slicer executable (default $PRUSA_SLICER or prusa-slicer).
 * @property {string[]} [origins] Extra allowed browser origins; "*" allows any.
 * @property {number} [timeoutMs] Longest a slice may run.
 * @property {number} [maxBodyBytes] Largest request accepted.
 * @property {(...args: unknown[]) => void} [log] Where job lines go (default console.log).
 * @property {string} [exportsDir] Where /open saves files (default the Downloads folder).
 * @property {DetectedApp[]} [apps] Apps to offer besides (or, with detect false, instead of) the detected ones.
 * @property {boolean} [detect] Look for known apps on this machine (default true).
 * @property {string[]} [openable] File types /open accepts (default DEFAULT_OPENABLE).
 * @property {(filePath: string, app: "default" | "reveal" | DetectedApp) => Promise<void>} [launch] How files are opened (default launchFile).
 * @property {string} [platform] Reported platform (default process.platform).
 */

/**
 * The bridge's HTTP server (not yet listening).
 * @param {BridgeOptions} [options]
 * @returns {import("node:http").Server}
 */
export function createBridgeServer({
    slicer = process.env.PRUSA_SLICER || "prusa-slicer",
    origins = [],
    timeoutMs = 600_000,
    maxBodyBytes = MAX_BODY_BYTES,
    log = (...args) => console.log(...args),
    exportsDir = defaultExportsDir(),
    apps = [],
    detect = true,
    openable = DEFAULT_OPENABLE,
    launch = launchFile,
    platform = process.platform,
} = {}) {
    const allowed = new Set([...DEFAULT_ORIGINS, ...origins]);
    const allowAny = allowed.has("*");
    const openableSet = new Set(openable.map((ext) => ext.toLowerCase().replace(/^\./, "")));
    const installed = detect ? detectApps({ platform, extra: apps }) : apps;
    let queue = Promise.resolve();
    let version;
    let slicerError;

    const send = (response, status, body, headers = {}) => {
        const text = body === undefined ? "" : JSON.stringify(body);
        response.writeHead(status, {
            ...headers,
            ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
        });
        response.end(text);
    };

    const health = async (response, cors) => {
        if (version === undefined) {
            const run = await runSlicer(slicer, ["--help"], { timeoutMs: 30_000 });
            const first = `${run.stdout}${run.stderr}`.split("\n").find((line) => line.trim() !== "");
            if (run.code !== 0 && !first) {
                slicerError = `cannot run ${describeSlicer(slicer)}: ${run.error ?? `exit ${run.code}`}`;
            } else {
                version = (first ?? "").trim();
                slicerError = undefined;
            }
        }
        send(
            response,
            200,
            {
                ok: true,
                platform,
                exportsDir,
                openable: [...openableSet],
                apps: installed,
                slicer: describeSlicer(slicer),
                version: version ?? null,
                ...(slicerError ? { slicerError } : {}),
            },
            cors,
        );
    };

    const open = async (request, response, cors) => {
        const { body: job, status, error } = await readJson(request, maxBodyBytes);
        if (!job) {
            send(response, status, { ok: false, error }, cors);
            return;
        }
        if (typeof job.file !== "string" || typeof job.name !== "string" || job.name.trim() === "") {
            send(
                response,
                400,
                { ok: false, error: 'expected { file: base64, name: "part.step", app? }' },
                cors,
            );
            return;
        }
        const bytes = Buffer.from(job.file, "base64");
        const name = safeFileName(job.name);
        const extension = path.extname(name).slice(1).toLowerCase();
        if (!openableSet.has(extension)) {
            send(response, 415, { ok: false, error: `the bridge does not open ".${extension}" files` }, cors);
            return;
        }
        const target = job.app === undefined || job.app === "default" ? "default" : job.app;
        const app = target === "default" ? "default" : installed.find((a) => a.id === target);
        if (!app) {
            send(
                response,
                404,
                {
                    ok: false,
                    error: `no app "${target}" (the bridge found ${installed.map((a) => a.id).join(", ") || "none"})`,
                },
                cors,
            );
            return;
        }
        const filePath = await saveExport(exportsDir, name, bytes);
        const label =
            app === "default" ? { id: "default", name: "default app" } : { id: app.id, name: app.name };
        try {
            await launch(filePath, app);
        } catch (launchError) {
            log(`open ${path.basename(filePath)} failed: ${launchError.message}`);
            send(response, 500, { ok: false, error: launchError.message, path: filePath }, cors);
            return;
        }
        log(`open ${path.basename(filePath)} → ${label.name} (${filePath})`);
        send(response, 200, { ok: true, path: filePath, app: label }, cors);
    };

    const reveal = async (request, response, cors) => {
        const { body: job, status, error } = await readJson(request, maxBodyBytes);
        if (!job) {
            send(response, status, { ok: false, error }, cors);
            return;
        }
        if (typeof job.path !== "string" || !isInside(exportsDir, job.path) || !isFile(job.path)) {
            send(response, 400, { ok: false, error: "expected { path } of a file the bridge saved" }, cors);
            return;
        }
        try {
            await launch(job.path, "reveal");
        } catch (launchError) {
            send(response, 500, { ok: false, error: launchError.message }, cors);
            return;
        }
        send(response, 200, { ok: true, path: job.path }, cors);
    };

    const slice = async (request, response, cors) => {
        const { body: job, status, error } = await readJson(request, maxBodyBytes);
        if (!job) {
            send(response, status, { ok: false, error }, cors);
            return;
        }
        if (typeof job?.model !== "string" || typeof job?.config !== "string") {
            send(
                response,
                400,
                { ok: false, error: "expected { model: base64, config: string, modelName?, arrange? }" },
                cors,
            );
            return;
        }
        const model = Buffer.from(job.model, "base64");
        if (model.length === 0) {
            send(response, 400, { ok: false, error: "the model is empty" }, cors);
            return;
        }
        const started = Date.now();
        const run = queue.then(() =>
            sliceJob({
                slicer,
                model,
                modelName: typeof job.modelName === "string" ? job.modelName : "job.3mf",
                config: job.config,
                arrange: job.arrange === true,
                timeoutMs,
            }),
        );
        queue = run.catch(() => undefined);
        const result = await run;
        log(
            `slice ${result.ok ? "ok" : `failed: ${result.error}`} in ${((Date.now() - started) / 1000).toFixed(1)} s`,
        );
        send(response, result.ok ? 200 : 422, result, cors);
    };

    return http.createServer(async (request, response) => {
        const origin = request.headers.origin;
        const cors = { Vary: "Origin" };
        if (origin !== undefined) {
            if (!allowAny && !allowed.has(origin)) {
                send(
                    response,
                    403,
                    {
                        ok: false,
                        error: `origin ${origin} is not allowed (start the bridge with --origin ${origin})`,
                    },
                    cors,
                );
                return;
            }
            cors["Access-Control-Allow-Origin"] = origin;
            cors["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
            cors["Access-Control-Allow-Headers"] = "Content-Type";
            cors["Access-Control-Max-Age"] = "600";
            // Chrome's private network access: a public page may call this local server.
            if (request.headers["access-control-request-private-network"] === "true") {
                cors["Access-Control-Allow-Private-Network"] = "true";
            }
        }
        const url = new URL(request.url ?? "/", "http://localhost");
        try {
            if (request.method === "OPTIONS") {
                send(response, 204, undefined, cors);
            } else if (request.method === "GET" && url.pathname === "/health") {
                await health(response, cors);
            } else if (request.method === "POST" && url.pathname === "/open") {
                await open(request, response, cors);
            } else if (request.method === "POST" && url.pathname === "/reveal") {
                await reveal(request, response, cors);
            } else if (request.method === "POST" && url.pathname === "/slice") {
                await slice(request, response, cors);
            } else {
                send(response, 404, { ok: false, error: `no ${request.method} ${url.pathname}` }, cors);
            }
        } catch (error) {
            send(
                response,
                500,
                { ok: false, error: error instanceof Error ? error.message : String(error) },
                cors,
            );
        }
    });
}

function parseArgs(argv) {
    const options = { origins: [], apps: [], allow: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
            return argv[++i];
        };
        if (arg === "--port") options.port = Number(value());
        else if (arg === "--host") options.host = value();
        else if (arg === "--slicer") options.slicer = value();
        else if (arg === "--origin") options.origins.push(value());
        else if (arg === "--timeout") options.timeoutMs = Number(value()) * 1000;
        else if (arg === "--exports") options.exportsDir = value();
        else if (arg === "--app") options.apps.push(parseAppSpec(value()));
        else if (arg === "--allow") options.allow.push(...value().split(","));
        else if (arg === "--no-detect") options.detect = false;
        else if (arg === "--help" || arg === "-h") options.help = true;
        else throw new Error(`unknown option ${arg}`);
    }
    return options;
}

const USAGE = `usage: node scripts/desktop-bridge.mjs [options]
  --port 7781            port on 127.0.0.1 (CHILI3D_BRIDGE_PORT)
  --host 127.0.0.1       address to listen on
  --exports <dir>        where opened exports are saved (CHILI3D_EXPORTS_DIR; default ~/Downloads)
  --app "Name[ext,ext]=command"
                         a program to offer, e.g. --app "FreeCAD[step,stl]=/opt/freecad/bin/FreeCAD"
                         (CHILI3D_APPS, ";"-separated); may repeat
  --allow ext,ext        more file types the bridge may open (CHILI3D_ALLOW)
  --no-detect            do not look for known programs (FreeCAD, PrusaSlicer, …)
  --slicer <path>        PrusaSlicer executable for the CAM Studio (PRUSA_SLICER)
  --origin <url>         allow a deployed app's origin (CHILI3D_ORIGINS); may repeat
  --timeout <seconds>    longest a slice may run (default 600)`;

export async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        console.log(USAGE);
        return;
    }
    const env = process.env;
    const port = options.port ?? Number(env.CHILI3D_BRIDGE_PORT || DEFAULT_PORT);
    const host = options.host ?? "127.0.0.1";
    const origins = [
        ...(env.CHILI3D_ORIGINS ? env.CHILI3D_ORIGINS.split(",").map((o) => o.trim()) : []),
        ...options.origins,
    ];
    const slicer = options.slicer ?? env.PRUSA_SLICER ?? "prusa-slicer";
    const exportsDir = path.resolve(options.exportsDir ?? env.CHILI3D_EXPORTS_DIR ?? defaultExportsDir());
    const apps = [
        ...(env.CHILI3D_APPS
            ? env.CHILI3D_APPS.split(";")
                  .filter((s) => s.trim())
                  .map(parseAppSpec)
            : []),
        ...options.apps,
    ];
    const openable = [
        ...DEFAULT_OPENABLE,
        ...(env.CHILI3D_ALLOW ? env.CHILI3D_ALLOW.split(",") : []),
        ...options.allow,
    ]
        .map((ext) => ext.trim())
        .filter(Boolean);
    const installed = options.detect === false ? apps : detectApps({ extra: apps });
    const server = createBridgeServer({
        slicer,
        origins,
        timeoutMs: options.timeoutMs,
        exportsDir,
        apps: installed,
        detect: false,
        openable,
    });
    await mkdir(exportsDir, { recursive: true });
    server.listen(port, host, () => {
        console.log(`Chili3d desktop bridge on http://${host}:${port}`);
        console.log(`  exports: ${exportsDir}`);
        console.log(
            `  apps:    ${installed.map((app) => `${app.name} (${app.command})`).join(", ") || "default programs only"}`,
        );
        console.log(`  slicer:  ${slicer}`);
        console.log(`  origins: ${[...DEFAULT_ORIGINS, ...origins].join(", ")}`);
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
