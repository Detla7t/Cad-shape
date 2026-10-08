// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const port = Number(process.argv[2] ?? 8096);
const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg",
    ".png": "image/png",
};
const policy =
    "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'";
// CSP blocks external asset/API requests in the browser before they reach the network.
// No service worker or warm browser cache is needed: every shipped asset is served locally.
createServer(async (request, response) => {
    response.setHeader("Content-Security-Policy", policy);
    response.setHeader("Cache-Control", "no-store");
    try {
        if (request.method !== "GET" && request.method !== "HEAD") {
            response.writeHead(405).end();
            return;
        }
        const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
        const file = resolve(root, `.${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`);
        if (!file.startsWith(resolve(root) + sep)) {
            response.writeHead(403).end();
            return;
        }
        const bytes = await readFile(file);
        response.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
        response.writeHead(200).end(request.method === "HEAD" ? undefined : bytes);
    } catch {
        response.writeHead(404).end("Not found");
    }
}).listen(port, "127.0.0.1", () =>
    console.log(`Offline asset preview: http://127.0.0.1:${port} (external requests blocked by CSP)`),
);
