// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { cp, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `next build` exports the static site into `packages/web/out`; deployment (the nginx image,
 * `npm run preview`, `external-assets --check-dist`, built plugins) works on `dist/`.
 */
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const out = resolve(root, "packages/web/out");
const dist = resolve(root, "dist");

await stat(out).catch(() => {
    throw new Error("packages/web/out is missing: run `next build packages/web --webpack` first");
});
await rm(dist, { recursive: true, force: true });
await cp(out, dist, { recursive: true, dereference: true });
console.log(`Copied the Next.js export to ${dist}`);
