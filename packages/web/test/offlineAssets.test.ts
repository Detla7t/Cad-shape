// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAssets } from "../../../scripts/external-assets.mjs";

test("all cached external assets match their recorded bytes and locked package versions", async () => {
    expect(await checkAssets()).toBeGreaterThan(200);
});

test("a corrupt cached asset fails verification instead of silently downloading a replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "chili-assets-test-"));
    const content = Buffer.from("original cached data");
    try {
        await mkdir(join(root, "public/vendor"), { recursive: true });
        await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: {} }));
        await writeFile(join(root, "public/videos.json"), "{}");
        await writeFile(join(root, "public/vendor/test.bin"), content);
        await writeFile(
            join(root, "public/vendor/assets.lock.json"),
            JSON.stringify({
                schemaVersion: 1,
                packages: {},
                files: [
                    {
                        path: "public/vendor/test.bin",
                        bytes: content.length,
                        sha256: createHash("sha256").update(content).digest("hex"),
                    },
                ],
            }),
        );
        expect(await checkAssets(root)).toBe(1);
        await writeFile(join(root, "public/vendor/test.bin"), Buffer.from("modified cached data"));
        await expect(checkAssets(root)).rejects.toThrow("Cached asset is corrupt: public/vendor/test.bin");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
