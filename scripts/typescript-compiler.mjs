// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKENDS = ["rust", "go", "legacy"];

/** @param {string} selection */
export function compilerOrder(selection) {
    if (selection === "auto") return [...BACKENDS];
    if (BACKENDS.includes(selection)) return [selection];
    throw new Error(`Unknown TypeScript compiler '${selection}'. Choose auto, rust, go, or legacy.`);
}

/** Resolve installed packages explicitly: npm aliases can otherwise compete for the tsc bin name. */
export function resolveCompiler(backend, root = PROJECT_ROOT) {
    const require = createRequire(join(root, "package.json"));
    const name = { rust: "tsc-rs", go: "typescript-go", legacy: "typescript" }[backend];
    const manifestPath = require.resolve(`${name}/package.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const label = `${backend} (${name}@${manifest.version})`;
    if (backend === "legacy") {
        return { command: process.execPath, args: [join(dirname(manifestPath), "bin/tsc")], label };
    }
    const platformPackage =
        backend === "rust"
            ? `@tsc-rs/${process.platform}-${process.arch}`
            : `@typescript/typescript-${process.platform}-${process.arch}`;
    const nativeManifest = createRequire(manifestPath).resolve(`${platformPackage}/package.json`);
    return {
        command: join(dirname(nativeManifest), "lib", process.platform === "win32" ? "tsc.exe" : "tsc"),
        args: [],
        label,
    };
}

/**
 * Run the native executable itself, so timeout/cancellation kills the compiler, not just its JS launcher.
 * @param {{command: string, args: string[], label: string}} executable
 * @param {string[]} args
 * @param {{cwd: string, timeoutMs: number, signal?: AbortSignal}} options
 * @returns {Promise<{status: number, stdout: string, stderr: string, failure?: string}>}
 */
export function executeCompiler(executable, args, { cwd, timeoutMs, signal }) {
    return new Promise((done) => {
        execFile(
            executable.command,
            [...executable.args, ...args, "--pretty", "false"],
            { cwd, timeout: timeoutMs, killSignal: "SIGKILL", signal, maxBuffer: 16 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (!error) return done({ status: 0, stdout, stderr });
                const diagnostic = /\bTS\d+:/.test(`${stdout}\n${stderr}`);
                // Diagnostic exits are authoritative. Never accept a weaker compiler's success instead.
                // Panics, missing platform packages, launch failures and timeouts may fail over.
                done({
                    status: typeof error.code === "number" ? error.code : 1,
                    stdout,
                    stderr,
                    failure: diagnostic ? undefined : error.message,
                });
            },
        );
    });
}

/**
 * Auto prefers Rust, then the matching Go compiler, then the retained TS 6 compiler.
 * Explicit selection is strict, to make compiler regressions visible in CI.
 * @param {string[]} args
 * @param {{compiler?: string, root?: string, cwd?: string, timeoutMs?: number, signal?: AbortSignal,
 * log?: (message: string) => void, resolveCommand?: typeof resolveCompiler}} options
 */
export async function runCompiler(args, options = {}) {
    const {
        compiler = process.env.CHILI_TS_COMPILER ?? "auto",
        root = PROJECT_ROOT,
        cwd = root,
        timeoutMs = 120_000,
        signal,
        log = console.error,
        resolveCommand = resolveCompiler,
    } = options;
    const order = compilerOrder(compiler);
    // Rspack owns the watch lifecycle; a CLI watch process would never finish (or fail over safely).
    if (args.some((arg) => ["--watch", "-w"].includes(arg.toLowerCase()))) {
        throw new Error("Use npm run dev for watched type checking; this runner performs one compilation.");
    }
    for (const [index, backend] of order.entries()) {
        if (signal?.aborted)
            return { status: 130, stdout: "", stderr: "TypeScript check cancelled.", backend };
        let result;
        try {
            const executable = resolveCommand(backend, root);
            log(`[typecheck] Using ${executable.label}`);
            result = await executeCompiler(executable, args, { cwd, timeoutMs, signal });
        } catch (error) {
            result = { status: 1, stdout: "", stderr: "", failure: String(error) };
        }
        if (signal?.aborted)
            return { status: 130, stdout: "", stderr: "TypeScript check cancelled.", backend };
        if (!result.failure) return { ...result, backend };
        log(`[typecheck] ${backend} could not complete: ${result.failure}`);
        const next = order[index + 1];
        if (next) log(`[typecheck] Falling back to ${next}.`);
        else return { ...result, stderr: result.stderr || result.failure, backend };
    }
    throw new Error("No TypeScript compiler selected.");
}

/** Strip our selection flag while passing TypeScript flags through unchanged. */
export function compilerArguments(args) {
    let compiler;
    const forwarded = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--compiler" || arg.startsWith("--compiler=")) {
            compiler = arg === "--compiler" ? args[++i] : arg.slice("--compiler=".length);
            compilerOrder(compiler);
        } else forwarded.push(arg);
    }
    return { compiler, args: forwarded };
}
