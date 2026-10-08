// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAssets } from "./external-assets.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = join(root, ".offline/npm-cache");
const verifyOnly = process.argv.includes("--verify");
const scratch = await mkdtemp(join(tmpdir(), "chili-offline-install-"));
function run(command, args, options = {}) {
    const result = spawnSync(command, args, { cwd: scratch, stdio: "inherit", ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}
try {
    await checkAssets();
    // Install into a disposable copy of just the workspace manifests. Never replace
    // the shared checkout's node_modules while another developer is using it.
    for (const name of ["package.json", "package-lock.json"])
        await copyFile(join(root, name), join(scratch, name));
    for (const parent of ["packages", "plugins"]) {
        for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const relative = join(parent, entry.name);
            let manifest;
            try {
                manifest = await readFile(join(root, relative, "package.json"));
            } catch (error) {
                if (error.code === "ENOENT") continue;
                throw error;
            }
            await mkdir(join(scratch, relative), { recursive: true });
            await writeFile(join(scratch, relative, "package.json"), manifest);
        }
    }
    const install = ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache];
    if (!verifyOnly) {
        console.log("Caching locked npm dependencies for this platform in .offline/npm-cache...");
        run("npm", install);
    }
    console.log("Verifying a fresh npm install with external networking disabled...");
    run(process.execPath, [join(root, "scripts/offline.mjs"), "npm", ...install, "--offline"]);
    // Exercise the installed native executables and their lib files, including with postinstall disabled.
    await mkdir(join(scratch, "scripts"), { recursive: true });
    for (const name of ["typecheck.mjs", "typescript-compiler.mjs"]) {
        await copyFile(join(root, "scripts", name), join(scratch, "scripts", name));
    }
    await writeFile(join(scratch, "compiler-smoke.ts"), "const lengthInMm: number = 12; export {};\n");
    await writeFile(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
            compilerOptions: { strict: true, target: "ES2022", types: [] },
            files: ["compiler-smoke.ts"],
        }),
    );
    const rustPackage = JSON.parse(await readFile(join(scratch, "node_modules/tsc-rs/package.json")));
    const rustSupported = `@tsc-rs/${process.platform}-${process.arch}` in rustPackage.optionalDependencies;
    for (const compiler of ["auto", ...(rustSupported ? ["rust"] : []), "go", "legacy"]) {
        run(process.execPath, [
            join(root, "scripts/offline.mjs"),
            process.execPath,
            "scripts/typecheck.mjs",
            "--compiler",
            compiler,
        ]);
    }
    const lock = await readFile(join(root, "package-lock.json"));
    await mkdir(join(root, ".offline"), { recursive: true });
    await writeFile(
        join(root, ".offline/prepared.json"),
        `${JSON.stringify(
            {
                packageLockSha256: createHash("sha256").update(lock).digest("hex"),
                platform: process.platform,
                arch: process.arch,
                node: process.version,
                verifiedAt: new Date().toISOString(),
            },
            null,
            4,
        )}\n`,
    );
    console.log("Offline npm installation verified. Keep .offline/npm-cache with the checkout.");
} finally {
    await rm(scratch, { recursive: true, force: true });
}
