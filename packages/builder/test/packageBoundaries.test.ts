// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkBoundaries, importsOf } from "../../../scripts/check-boundaries.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface FakePackage {
    deps?: string[];
    exports?: Record<string, string>;
    files?: Record<string, string>;
}

/** A throwaway workspace: packages/<name>/package.json plus source files. */
function workspace(packages: Record<string, FakePackage>): string {
    const root = mkdtempSync(path.join(tmpdir(), "chili-boundaries-"));
    for (const [name, pkg] of Object.entries(packages)) {
        const dir = path.join(root, "packages", name);
        mkdirSync(dir, { recursive: true });
        const devDependencies = Object.fromEntries((pkg.deps ?? []).map((dep) => [`@chili3d/${dep}`, "*"]));
        writeFileSync(
            path.join(dir, "package.json"),
            JSON.stringify({ name: `@chili3d/${name}`, devDependencies, exports: pkg.exports }),
        );
        for (const [file, text] of Object.entries(pkg.files ?? {})) {
            mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
            writeFileSync(path.join(dir, file), text);
        }
    }
    return root;
}

const graph = { core: [], engine: ["core"], feature: ["core", "engine"], app: ["core", "feature"] };
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function check(
    packages: Record<string, FakePackage>,
    exceptions: { files: string[]; target: string; reason: string }[] = [],
) {
    const root = workspace(packages);
    roots.push(root);
    return checkBoundaries(root, { graph, exceptions })
        .violations.map((violation: { kind: string; file: string }) => `${violation.kind} ${violation.file}`)
        .sort();
}

describe("package boundary check", () => {
    test("the repository's packages hold their boundaries", () => {
        expect(checkBoundaries(repoRoot).violations).toEqual([]);
    });

    test("finds static, re-export, side-effect, dynamic and require imports, not comments", () => {
        const text = [
            'import { a } from "@chili3d/core";',
            'export * from "./local";',
            'import "@chili3d/engine/setup";',
            'const lazy = () => import("@chili3d/feature");',
            'const old = require("../other/src/x");',
            '// import "@chili3d/app";',
            'const text = "import x from \\"@chili3d/app\\"";',
        ].join("\n");
        expect(importsOf(text)).toEqual([
            "@chili3d/core",
            "./local",
            "@chili3d/engine/setup",
            "@chili3d/feature",
            "../other/src/x",
        ]);
    });

    test("a clean workspace passes", () => {
        expect(
            check({
                core: { files: { "src/index.ts": "export const x = 1;" } },
                engine: { deps: ["core"], files: { "src/index.ts": 'import { x } from "@chili3d/core";' } },
                feature: {
                    deps: ["core", "engine"],
                    files: { "src/index.ts": 'export * from "@chili3d/engine";\nimport "./local";' },
                },
                app: { deps: ["core", "feature"] },
            }),
        ).toEqual([]);
    });

    test("an import of an undeclared package is refused in source", () => {
        expect(
            check({
                core: {},
                engine: { files: { "src/index.ts": 'import { x } from "@chili3d/core";' } },
                feature: {},
                app: {},
            }),
        ).toEqual(["undeclared packages/engine/src/index.ts"]);
    });

    test("a declared dependency against the graph's direction is refused", () => {
        expect(check({ core: {}, engine: { deps: ["core", "feature"] }, feature: {}, app: {} })).toEqual([
            "direction packages/engine/package.json",
        ]);
    });

    test("deep imports: src/ paths, unexported subpaths and relative paths into another package", () => {
        expect(
            check({
                core: { files: { "src/model/a.ts": "export const a = 1;" } },
                engine: {
                    deps: ["core"],
                    exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
                    files: {
                        "src/index.ts": [
                            'import { a } from "@chili3d/core/src/model/a";',
                            'import { b } from "../../core/src/model/a";',
                        ].join("\n"),
                    },
                },
                feature: {
                    deps: ["core", "engine"],
                    // Only the entry is exported, so `@chili3d/feature/internal` is a deep import.
                    exports: { ".": "./src/index.ts" },
                    files: { "src/index.ts": 'import { lang } from "@chili3d/engine/lang/values";' },
                },
                app: {
                    deps: ["core", "feature"],
                    files: { "src/index.ts": 'import { y } from "@chili3d/feature/internal";' },
                },
            }),
        ).toEqual([
            "deep-import packages/app/src/index.ts",
            "deep-import packages/engine/src/index.ts",
            "deep-import packages/engine/src/index.ts",
        ]);
    });

    test("tests may use a package beside or above theirs, never one that depends on them", () => {
        expect(
            check({
                core: {},
                engine: {
                    deps: ["core"],
                    files: {
                        // app depends on engine (through feature): a cycle.
                        "test/upward.test.ts": 'import { App } from "@chili3d/app";',
                    },
                },
                feature: { deps: ["core", "engine"] },
                app: {
                    deps: ["core", "feature"],
                    // engine is below app, only not declared: fine in a test.
                    files: { "test/integration.test.ts": 'import { run } from "@chili3d/engine";' },
                },
            }),
        ).toEqual(["undeclared packages/engine/test/upward.test.ts"]);
    });

    test("cycles, unknown packages and stale exceptions are reported", () => {
        const cyclic = { ...graph, core: ["app"] };
        const root = workspace({ core: {}, engine: {}, feature: {}, app: {}, extra: {} });
        roots.push(root);
        const kinds = checkBoundaries(root, {
            graph: cyclic,
            exceptions: [{ files: ["packages/app/src/gone.ts"], target: "core", reason: "fixed long ago" }],
        }).violations.map((violation: { kind: string }) => violation.kind);
        expect([...new Set(kinds)].sort()).toEqual(["cycle", "stale-exception", "unknown-package"]);
    });

    test("an exception covers exactly its file and target package", () => {
        const packages = {
            core: {},
            engine: { files: { "test/helper.ts": 'import "../../app/src/setup";' } },
            feature: {},
            app: {},
        };
        expect(check(packages)).toEqual(["deep-import packages/engine/test/helper.ts"]);
        expect(
            check(packages, [{ files: ["packages/engine/test/helper.ts"], target: "app", reason: "setup" }]),
        ).toEqual([]);
        expect(
            check(packages, [{ files: ["packages/engine/test/helper.ts"], target: "core", reason: "wrong" }]),
        ).toEqual([
            "deep-import packages/engine/test/helper.ts",
            "stale-exception packages/engine/test/helper.ts",
        ]);
    });
});
