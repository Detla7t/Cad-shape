// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(join(root, ".offline"), { recursive: true });
// Cargo records each crate's upstream checksum in the vendor directory. Keep its
// generated source-replacement config with the cache so tests never need the registry.
const vendor = spawnSync(
    "cargo",
    ["vendor", "--locked", "--manifest-path", "rust/Cargo.toml", ".offline/rust-vendor"],
    {
        cwd: root,
        stdio: ["ignore", "pipe", "inherit"],
        encoding: "utf8",
    },
);
if (vendor.error) throw vendor.error;
if (vendor.status !== 0) throw new Error("Could not cache Rust dependencies");
await writeFile(join(root, ".offline/rust-config.toml"), vendor.stdout);
const check = spawnSync("npm", ["run", "test:rust:offline"], {
    cwd: root,
    stdio: "inherit",
});
if (check.error) throw check.error;
process.exitCode = check.status ?? 1;
