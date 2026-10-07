#!/usr/bin/env node
// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Local PrusaSlicer bridge for Chili3d's CAM Studio: a small HTTP server on this machine that
 * slices with the installed PrusaSlicer command line, so the browser app can use it.
 *
 *   node scripts/prusa-slicer-bridge.mjs [--port 7781] [--host 127.0.0.1]
 *        [--slicer /path/to/prusa-slicer] [--origin https://your.chili3d.host] [--timeout 600]
 *
 * Environment: PRUSA_SLICER (slicer executable), CHILI3D_BRIDGE_PORT, CHILI3D_ORIGINS
 * (comma-separated extra allowed origins). The app's dev server origins
 * (http://localhost:8080, http://127.0.0.1:8080) are always allowed; requests without an
 * Origin header (curl) are accepted; other browser origins are refused.
 *
 * Protocol:
 *   GET  /health → { ok, slicer, version }
 *   POST /slice  { model: <base64 3MF or STL>, modelName: "job.3mf", config: <INI text>,
 *                  arrange?: boolean }
 *             → { ok: true, gcode, log } | { ok: false, error, log }
 *
 * A job writes the model and the INI into a fresh temporary directory, runs
 *   prusa-slicer --export-gcode [--dont-arrange] --load job.ini --output job.gcode job.3mf
 * (always ASCII G-code: `binary_gcode = 0` is appended to the INI), returns the G-code and
 * removes the directory. Jobs run one at a time. The server listens on 127.0.0.1 only.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_PORT = 7781;
export const DEFAULT_ORIGINS = ["http://localhost:8080", "http://127.0.0.1:8080"];
const MAX_BODY_BYTES = 512 * 1024 * 1024;
const MODEL_EXTENSIONS = new Set(["3mf", "stl", "obj", "amf"]);

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

/**
 * @typedef {string | { command: string, args?: string[] }} SlicerCommand
 * @typedef {object} BridgeOptions
 * @property {SlicerCommand} [slicer] The slicer executable (default $PRUSA_SLICER or prusa-slicer).
 * @property {string[]} [origins] Extra allowed browser origins; "*" allows any.
 * @property {number} [timeoutMs] Longest a slice may run.
 * @property {number} [maxBodyBytes] Largest request accepted.
 * @property {(...args: unknown[]) => void} [log] Where job lines go (default console.log).
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
} = {}) {
    const allowed = new Set([...DEFAULT_ORIGINS, ...origins]);
    const allowAny = allowed.has("*");
    let queue = Promise.resolve();
    let version;

    const send = (response, status, body, headers = {}) => {
        const text = body === undefined ? "" : JSON.stringify(body);
        response.writeHead(status, {
            ...headers,
            ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
        });
        response.end(text);
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
                if (version === undefined) {
                    const run = await runSlicer(slicer, ["--help"], { timeoutMs: 30_000 });
                    const first = `${run.stdout}${run.stderr}`.split("\n").find((line) => line.trim() !== "");
                    if (run.code !== 0 && !first) {
                        send(
                            response,
                            503,
                            {
                                ok: false,
                                error: `cannot run ${describeSlicer(slicer)}: ${run.error ?? `exit ${run.code}`}`,
                            },
                            cors,
                        );
                        return;
                    }
                    version = (first ?? "").trim();
                }
                send(response, 200, { ok: true, slicer: describeSlicer(slicer), version }, cors);
            } else if (request.method === "POST" && url.pathname === "/slice") {
                let job;
                try {
                    job = JSON.parse((await readBody(request, maxBodyBytes)).toString("utf8"));
                } catch (error) {
                    send(
                        response,
                        error.status ?? 400,
                        { ok: false, error: error.status ? error.message : "the body is not JSON" },
                        cors,
                    );
                    return;
                }
                if (typeof job?.model !== "string" || typeof job?.config !== "string") {
                    send(
                        response,
                        400,
                        {
                            ok: false,
                            error: "expected { model: base64, config: string, modelName?, arrange? }",
                        },
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
    const options = { origins: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => argv[++i];
        if (arg === "--port") options.port = Number(value());
        else if (arg === "--host") options.host = value();
        else if (arg === "--slicer") options.slicer = value();
        else if (arg === "--origin") options.origins.push(value());
        else if (arg === "--timeout") options.timeoutMs = Number(value()) * 1000;
        else if (arg === "--help" || arg === "-h") options.help = true;
        else throw new Error(`unknown option ${arg}`);
    }
    return options;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(
            "usage: node scripts/prusa-slicer-bridge.mjs [--port 7781] [--host 127.0.0.1] [--slicer path] [--origin url] [--timeout seconds]",
        );
        return;
    }
    const port = options.port ?? Number(process.env.CHILI3D_BRIDGE_PORT || DEFAULT_PORT);
    const host = options.host ?? "127.0.0.1";
    const origins = [
        ...(process.env.CHILI3D_ORIGINS ? process.env.CHILI3D_ORIGINS.split(",").map((o) => o.trim()) : []),
        ...options.origins,
    ];
    const slicer = options.slicer ?? process.env.PRUSA_SLICER ?? "prusa-slicer";
    const server = createBridgeServer({ slicer, origins, timeoutMs: options.timeoutMs });
    server.listen(port, host, () => {
        console.log(`Chili3d PrusaSlicer bridge on http://${host}:${port}`);
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
