// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve, sep } from "node:path";
import { PROJECT_ROOT, runCompiler } from "./typescript-compiler.mjs";

/**
 * `npm run dev`: the Next.js dev server (Turbopack — the app is up in a few seconds and cached
 * between runs in packages/web/.next) with the workspace type check beside it. Turbopack does
 * not type-check, and blocking each compile on it (as the webpack build does) would cost the
 * fast start, so it runs in the background: once at start and again after source changes,
 * printing a summary and any errors to this terminal.
 */

const args = process.argv.slice(2);
const next = spawn("npx", ["next", "dev", "packages/web", ...args], { cwd: PROJECT_ROOT, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => next.kill(signal));
next.on("exit", (code) => process.exit(code ?? 0));

const IGNORED = new Set(["node_modules", ".next", "out", "dist", "lib", "target"]);
const tsconfig = resolve(PROJECT_ROOT, "tsconfig.json");
let running;
let again = false;
let timer;

async function check() {
    if (running) {
        again = true;
        running.abort();
        return;
    }
    running = new AbortController();
    const started = performance.now();
    try {
        const result = await runCompiler(["--noEmit", "--project", tsconfig], {
            signal: running.signal,
            log: () => {},
        });
        if (result.status === 130) return;
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        if (result.status === 0)
            console.log(`\x1b[32m[typecheck]\x1b[0m no type errors (${result.backend}, ${seconds}s)`);
        else {
            const errors = `${result.stdout}${result.stderr}`.trim();
            const count = (errors.match(/error TS\d+/g) ?? []).length;
            console.log(
                `\x1b[31m[typecheck]\x1b[0m ${count} type error(s) (${result.backend}, ${seconds}s):\n${errors}`,
            );
        }
    } catch (error) {
        console.log(`[typecheck] ${String(error)}`);
    } finally {
        running = undefined;
        if (again) {
            again = false;
            schedule();
        }
    }
}

function schedule() {
    clearTimeout(timer);
    timer = setTimeout(check, 300);
}

for (const folder of ["packages", "plugins"]) {
    watch(resolve(PROJECT_ROOT, folder), { recursive: true }, (_event, file) => {
        if (!file || !/\.(ts|tsx|mts|d\.ts)$/.test(file)) return;
        if (file.split(sep).some((part) => IGNORED.has(part))) return;
        schedule();
    });
}
check();
