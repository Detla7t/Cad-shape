// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "packages/wasm/build-manifest.json");
const digest = (file) =>
    createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex");
const sourceFiles = [
    "cpp/CMakeLists.txt",
    ...readdirSync(path.join(root, "cpp/src"))
        .filter((file) => /\.(cpp|hpp)$/.test(file))
        .map((file) => `cpp/src/${file}`),
].sort();
const artifacts = ["js", "wasm", "d.ts"].map((extension) => `packages/wasm/lib/chili-wasm.${extension}`);
const hashes = (files) => Object.fromEntries(files.map((file) => [file, digest(file)]));
const actual = { sources: hashes(sourceFiles), artifacts: hashes(artifacts) };

if (process.argv.includes("--verify")) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const category of ["sources", "artifacts"]) {
        if (JSON.stringify(manifest[category]) !== JSON.stringify(actual[category]))
            throw new Error(
                `WASM ${category} differ from the recorded native build. Rebuild WASM and record its provenance.`,
            );
    }
    console.log("Native source and artifact hashes match the recorded build.");
} else {
    // Run in the actual build toolchain (emsdk environment or its equivalent).
    // Recording a tool version is evidence about the artifact, not a claim that
    // an arbitrary later build is byte-for-byte reproducible.
    const emcc = process.env["EMCC"] ?? path.join(root, "cpp/build/emsdk/upstream/emscripten/emcc");
    const compiler = execFileSync(emcc, ["--version"], { encoding: "utf8" }).split("\n")[0];
    const occtDirectory = path.join(root, "cpp/build/occt");
    const occtCommit = execFileSync("git", ["-C", occtDirectory, "rev-parse", "HEAD"], {
        encoding: "utf8",
    }).trim();
    const changed = execFileSync(
        "git",
        ["-C", occtDirectory, "status", "--porcelain", "--untracked-files=no"],
        { encoding: "utf8" },
    ).trim();
    if (changed !== "")
        throw new Error(
            "OCCT has modified tracked sources; record a clean source revision before publishing the build.",
        );
    writeFileSync(
        manifestPath,
        `${JSON.stringify({ format: 1, compiler, occtCommit, ...actual }, null, 4)}\n`,
    );
    console.log("Recorded WASM compiler, OCCT revision, source hashes and artifact hashes.");
}
