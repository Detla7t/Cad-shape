// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PROJECT_ROOT } from "../../../scripts/typescript-compiler.mjs";

test("Rspack watch reports and recovers from errors in existing and new files outside its module graph", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "chili checker watch "));
    try {
        await mkdir(join(scratch, "tests"));
        await symlink(join(PROJECT_ROOT, "node_modules"), join(scratch, "node_modules"), "junction");
        await writeFile(join(scratch, "package.json"), '{"type":"module"}');
        await writeFile(join(scratch, "index.js"), "export const value = 12;");
        await writeFile(join(scratch, "tests/model.ts"), "export const length: number = 12;");
        await writeFile(
            join(scratch, "tsconfig.json"),
            JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ["tests/**/*.ts"] }),
        );
        // Run real Rspack in Node: bundling Rspack itself into a test worker changes its module loader.
        const { stdout } = await promisify(execFile)(
            process.execPath,
            [
                "--input-type=module",
                "--eval",
                `
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
const [root, pluginUrl] = process.argv.slice(1);
const { rspack } = createRequire(join(root, "package.json"))("@rspack/core");
const { TypecheckPlugin } = await import(pluginUrl);
const compiler = rspack({
    mode: "development", context: root, entry: "./index.js",
    output: { path: join(root, "dist"), filename: "main.js" },
    plugins: [new TypecheckPlugin(root)],
});
let watcher;
let timer;
let stage = 0;
try {
    await new Promise((done, reject) => {
        timer = setTimeout(() => reject(new Error("Watch stalled at stage " + stage)), 20000);
        watcher = compiler.watch({ aggregateTimeout: 25 }, async (error, stats) => {
            try {
                if (error) throw error;
                const text = stats.toString({ all: false, errors: true });
                assert.equal(stats.hasErrors(), stage === 1 || stage === 3, text);
                if (stage === 1 || stage === 3) assert.match(text, /TS2322/);
                switch (stage++) {
                    case 0: await writeFile(join(root, "tests/model.ts"), 'export const length: number = "bad";'); break;
                    case 1: await writeFile(join(root, "tests/model.ts"), "export const length: number = 24;"); break;
                    case 2: await writeFile(join(root, "tests/new.ts"), 'export const width: number = "bad";'); break;
                    case 3: await rm(join(root, "tests/new.ts")); break;
                    case 4: done(); break;
                }
            } catch (error) { reject(error); }
        });
    });
} finally {
    clearTimeout(timer);
    await new Promise((done) => watcher.close(done));
    await new Promise((done) => compiler.close(done));
}
console.log("WATCH_VALIDATED: " + stage);
`,
                scratch,
                pathToFileURL(join(PROJECT_ROOT, "scripts/typecheck-plugin.mjs")).href,
            ],
            { cwd: PROJECT_ROOT, timeout: 30_000, env: { ...process.env, CHILI_TS_COMPILER: "auto" } },
        );
        expect(stdout).toContain("WATCH_VALIDATED: 5");
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
}, 35_000);
