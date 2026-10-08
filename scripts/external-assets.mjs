// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = "public/vendor/assets.lock.json";
const THUMBNAILS = [
    ["i1.hdslb.com", "7b92bdd63b5766189a7aafde81f294ec1b95a99e"],
    ["i2.hdslb.com", "bf0d135ad8d64581c2b8f2e351992306d95bda4c"],
    ["i1.hdslb.com", "0bb15776e1d3e5d79bfa0d99de6419504b383f2c"],
    ["i0.hdslb.com", "add83fc6ccd7ed43a92c2f55e95d66daffb69132"],
    ["i0.hdslb.com", "be99bc8aed70ad8e667ffe7f93d84bc80d1a889b"],
];
const PACKAGES = [
    {
        name: "pdfjs-dist",
        destination: "pdfjs",
        entries: ["cmaps", "standard_fonts", "wasm", "iccs", "LICENSE"],
    },
    { name: "ace-builds", destination: "ace", entries: ["LICENSE"] },
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function filesAt(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const paths = await Promise.all(
        entries.map(async (entry) => {
            const path = join(directory, entry.name);
            return entry.isDirectory() ? filesAt(path) : [path];
        }),
    );
    return paths.flat().sort();
}

/** Explicit maintenance command; normal builds and tests never refresh or fetch assets. */
async function refresh() {
    const files = [];
    const packages = {};
    async function save(path, bytes, source) {
        await mkdir(dirname(join(ROOT, path)), { recursive: true });
        await writeFile(join(ROOT, path), bytes);
        files.push({ path, bytes: bytes.length, sha256: sha256(bytes), source });
    }
    for (const pkg of PACKAGES) {
        const base = join(ROOT, "node_modules", pkg.name);
        const metadata = JSON.parse(await readFile(join(base, "package.json"), "utf8"));
        packages[pkg.name] = metadata.version;
        for (const entry of pkg.entries) {
            const paths = entry === "LICENSE" ? [join(base, entry)] : await filesAt(join(base, entry));
            for (const path of paths) {
                const relative = path.slice(base.length + 1).replaceAll("\\", "/");
                await save(
                    `public/vendor/${pkg.destination}/${relative}`,
                    await readFile(path),
                    `npm:${pkg.name}@${metadata.version}/${relative}`,
                );
            }
        }
    }
    for (const [host, id] of THUMBNAILS) {
        const url = `https://${host}/bfs/archive/${id}.jpg`;
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(`${url}: expected a JPEG`);
        await save(`public/images/videos/${id}.jpg`, bytes, url);
    }
    const videosPath = join(ROOT, "public/videos.json");
    const videos = JSON.parse(await readFile(videosPath, "utf8"));
    for (const group of Object.values(videos)) {
        for (const item of group.items) {
            const name = item.thumbnail.split("/").at(-1);
            item.thumbnail = `images/videos/${name}`;
        }
    }
    await writeFile(videosPath, `${JSON.stringify(videos, null, 4)}\n`);
    await writeFile(
        join(ROOT, LOCK),
        `${JSON.stringify(
            {
                schemaVersion: 1,
                packages,
                thumbnailRights:
                    "Original video artwork; respective authors retain their rights. Source URLs are recorded per file.",
                files: files.sort((a, b) => a.path.localeCompare(b.path)),
            },
            null,
            4,
        )}\n`,
    );
    console.log(`Stored ${files.length} assets and their SHA-256 checksums.`);
}

/** Checks recorded bytes and package versions without contacting their origins. */
export async function checkAssets(root = ROOT, distribution = false) {
    const manifest = JSON.parse(await readFile(join(root, LOCK), "utf8"));
    if (manifest.schemaVersion !== 1 || !manifest.files?.length) throw new Error("Invalid asset manifest");
    const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
    for (const [name, version] of Object.entries(manifest.packages)) {
        const installed = JSON.parse(
            await readFile(join(root, "node_modules", name, "package.json"), "utf8"),
        );
        if (installed.version !== version || lock.packages[`node_modules/${name}`]?.version !== version)
            throw new Error(`${name} changed; run npm run assets:refresh and review the asset changes`);
    }
    const seen = new Set();
    for (const asset of manifest.files) {
        if (!asset.path.startsWith("public/") || asset.path.includes("..") || seen.has(asset.path))
            throw new Error(`Invalid or duplicate asset path: ${asset.path}`);
        seen.add(asset.path);
        const path = distribution ? asset.path.replace(/^public\//, "dist/") : asset.path;
        const bytes = await readFile(join(root, path));
        if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256)
            throw new Error(`Cached asset is corrupt: ${path}`);
    }
    const videos = JSON.parse(await readFile(join(root, "public/videos.json"), "utf8"));
    for (const group of Object.values(videos)) {
        for (const item of group.items) {
            if (!seen.has(`public/${item.thumbnail}`))
                throw new Error(`Uncached thumbnail: ${item.thumbnail}`);
        }
    }
    return manifest.files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv[2] === "--refresh") await refresh();
    else if (process.argv.length === 2 || process.argv[2] === "--check")
        console.log(`Verified ${await checkAssets()} local assets; no downloads.`);
    else if (process.argv[2] === "--check-dist")
        console.log(`Verified ${await checkAssets(ROOT, true)} built assets against their cached checksums.`);
    else throw new Error("Usage: node scripts/external-assets.mjs [--check | --check-dist | --refresh]");
}
