// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Package boundary check: every workspace package may import only the workspace packages it
 * declares in its package.json, every declared workspace dependency must follow the dependency
 * direction below (the graph in CLAUDE.md), and nothing may reach into another package's
 * internals — `@chili3d/x/src/...`, a subpath the package does not export, or a relative path
 * into another package's folder.
 *
 *     node scripts/check-boundaries.mjs          # exit code 1 on any violation
 *     node scripts/check-boundaries.mjs --graph  # print the allowed graph
 *
 * Tests (files under a package's test/ or test-utils/ folder) may also import, through its public
 * entry, a workspace package they do not declare, as long as that package does not depend on
 * theirs: an integration test may use a package beside or above it in the graph, never one that
 * would close a cycle. Deep imports are refused in tests too.
 *
 * A new package needs an entry in DEPENDENCY_GRAPH; a new edge is a design decision, so it is
 * made here (and in CLAUDE.md), not only in a package.json.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** @typedef {Readonly<Record<string, readonly string[]>>} DependencyGraph */
/** @typedef {{ readonly files: readonly string[]; readonly target: string; readonly reason: string }} BoundaryException */

/**
 * Allowed workspace dependencies per package (folder name under packages/), the CLAUDE.md graph.
 * @type {DependencyGraph}
 */
export const DEPENDENCY_GRAPH = {
    // Leaves: no workspace dependencies.
    core: [],
    drawing: [],
    rs: [],
    "onshape-std": [],
    "office-io": [],
    // Over core.
    element: ["core"],
    i18n: ["core"],
    storage: ["core"],
    wasm: ["core"],
    "code-editor": ["core"],
    featurescript: ["core"],
    react: ["core", "drawing"],
    three: ["core", "element"],
    sheet: ["core", "office-io"],
    richtext: ["core", "office-io"],
    // Feature modules.
    parametric: ["core", "drawing", "element", "featurescript"],
    assembly: ["core", "element"],
    data: ["core", "element", "react"],
    ai: ["core", "element", "parametric"],
    ui: ["core", "element", "react", "ai"],
    cam: ["core", "element", "parametric", "rs", "wasm", "react", "code-editor"],
    documents: [
        "core",
        "drawing",
        "element",
        "parametric",
        "react",
        "code-editor",
        "sheet",
        "richtext",
        "office-io",
    ],
    fabrication: ["core", "drawing", "parametric", "documents"],
    app: ["core", "element", "wasm"],
    // Composition.
    builder: [
        "core",
        "element",
        "app",
        "assembly",
        "cam",
        "data",
        "documents",
        "fabrication",
        "i18n",
        "onshape-std",
        "parametric",
        "rs",
        "storage",
        "three",
        "ui",
        "wasm",
    ],
    web: ["core", "builder", "react"],
};

/**
 * @type {readonly BoundaryException[]}
 * Known crossings, each with the reason it is kept. A stale entry (one that no longer matches a
 * violation) is itself reported, so the list only shrinks.
 */
export const EXCEPTIONS = [
    {
        files: ["packages/featurescript/test/_helpers/cadHost.ts"],
        target: "parametric",
        reason: "Upward, test-only: Onshape's std solves every sketch, so the engine's kernel tests install parametric's modeling host (history completion, profile rules, garlic solver) to run in the app's configuration.",
    },
    {
        files: [
            "packages/assembly/test/parametricLink.kernel.test.ts",
            "packages/data/test/dataModel.kernel.test.ts",
            "packages/fabrication/test/endCapNative.test.ts",
            "packages/fabrication/test/endCapSketch.kernel.test.ts",
        ],
        target: "parametric",
        reason: "Shared test setup: parametric/test/sketch/setup loads the garlic solver wasm synchronously (and data's test reuses parametric's bundled Onshape std helper); parametric has no published test-utils entry.",
    },
    {
        files: [
            "packages/ui/test/_helpers/mockCoreBinding.ts",
            "packages/ui/test/_helpers/mockCoreConfig.ts",
            "packages/ui/test/_helpers/mockCoreProperty.ts",
            "packages/ui/test/_helpers/mockCorePropertyView.ts",
            "packages/ui/test/_helpers/mockCoreTree.ts",
            "packages/ui/test/treeItem.test.ts",
        ],
        target: "core",
        reason: "These ui tests mock @chili3d/core with a partial snapshot, so the real modules the mock keeps (evaluation state, configured values, Result, ...) can only be loaded by path.",
    },
    {
        files: [
            "packages/ui/test/geometryPanel.kernel.test.ts",
            "packages/ui/test/measurePanel.kernel.test.ts",
        ],
        target: "parametric",
        reason: "The panels' kernel tests load only parametric's measurement providers (side-effect modules), not the whole package with its commands and registrations.",
    },
    {
        files: ["packages/parametric/test/featurescript/exportParity.kernel.test.ts"],
        target: "documents",
        reason: "Upward, test-only: compares FeatureScript drawings with the documents HLR projection (documents depends on parametric); it belongs with the export-compare script until it moves to documents/test.",
    },
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "lib", "dist", "out", ".next", "coverage", "public"]);
const SCOPE = "@chili3d/";

const toPosix = (file) => file.split(path.sep).join("/");

function sourceFiles(directory) {
    const files = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith("."))
                    walk(path.join(dir, entry.name));
            } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) {
                files.push(path.join(dir, entry.name));
            }
        }
    };
    walk(directory);
    return files;
}

/** The workspace packages under `root/packages`, keyed by folder name. */
export function readWorkspace(root) {
    const packagesDir = path.join(root, "packages");
    const packages = new Map();
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
        const manifestPath = path.join(packagesDir, entry.name, "package.json");
        if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const declared = Object.keys({
            ...manifest.dependencies,
            ...manifest.devDependencies,
            ...manifest.peerDependencies,
        })
            .filter((name) => name.startsWith(SCOPE))
            .map((name) => name.slice(SCOPE.length));
        packages.set(entry.name, {
            folder: entry.name,
            name: manifest.name,
            dir: path.join(packagesDir, entry.name),
            declared,
            exports: manifest.exports,
        });
    }
    return packages;
}

/** Whether `subpath` (without the package name, e.g. "formula") is exported by an `exports` map. */
function isExported(exportsField, subpath) {
    if (exportsField === undefined) return true;
    if (typeof exportsField === "string") return false;
    const key = `./${subpath}`;
    for (const pattern of Object.keys(exportsField)) {
        if (pattern === key) return true;
        const star = pattern.indexOf("*");
        if (star >= 0 && key.startsWith(pattern.slice(0, star)) && key.endsWith(pattern.slice(star + 1)))
            return true;
    }
    return false;
}

/** Every import specifier of a source file: static, re-export, side-effect and dynamic imports. */
export function importsOf(text) {
    return ts.preProcessFile(text, true, true).importedFiles.map((file) => file.fileName);
}

/** Whether a file is test code: under a package's test/ or test-utils/ folder. */
export function isTestFile(file) {
    return /^packages\/[^/]+\/(test|test-utils)\//.test(file);
}

/** Whether `from` reaches `to` in the graph (directly or through other packages). */
export function dependsOn(graph, from, to) {
    const seen = new Set();
    const stack = [from];
    while (stack.length > 0) {
        const node = stack.pop();
        if (node === to) return true;
        if (seen.has(node)) continue;
        seen.add(node);
        stack.push(...(graph[node] ?? []));
    }
    return false;
}

function packageOfPath(packages, absolute) {
    for (const pkg of packages.values()) {
        const relative = path.relative(pkg.dir, absolute);
        if (!relative.startsWith("..") && !path.isAbsolute(relative)) return pkg;
    }
    return undefined;
}

/** Checks the dependency graph itself: known packages, declared edges in direction, no cycles. */
export function checkGraph(packages, graph = DEPENDENCY_GRAPH) {
    const problems = [];
    for (const pkg of packages.values()) {
        const allowed = graph[pkg.folder];
        if (allowed === undefined) {
            problems.push({
                kind: "unknown-package",
                file: `packages/${pkg.folder}/package.json`,
                message: `${pkg.name} is not in DEPENDENCY_GRAPH (scripts/check-boundaries.mjs); add it with its allowed dependencies`,
            });
            continue;
        }
        for (const dependency of pkg.declared) {
            if (!packages.has(dependency))
                problems.push({
                    kind: "unknown-dependency",
                    file: `packages/${pkg.folder}/package.json`,
                    target: dependency,
                    message: `${pkg.name} declares ${SCOPE}${dependency}, which is not a workspace package`,
                });
            else if (!allowed.includes(dependency))
                problems.push({
                    kind: "direction",
                    file: `packages/${pkg.folder}/package.json`,
                    target: dependency,
                    message: `${pkg.name} declares ${SCOPE}${dependency}, against the dependency direction (allowed: ${allowed.join(", ") || "none"})`,
                });
        }
    }
    const visiting = new Set();
    const done = new Set();
    const visit = (node, trail) => {
        if (done.has(node)) return;
        if (visiting.has(node)) {
            problems.push({
                kind: "cycle",
                file: "scripts/check-boundaries.mjs",
                message: `dependency cycle: ${[...trail.slice(trail.indexOf(node)), node].join(" -> ")}`,
            });
            return;
        }
        visiting.add(node);
        for (const next of graph[node] ?? []) visit(next, [...trail, node]);
        visiting.delete(node);
        done.add(node);
    };
    for (const node of Object.keys(graph)) visit(node, []);
    return problems;
}

/** Checks every import of every package source file against the declared dependencies. */
export function checkImports(root, packages, graph = DEPENDENCY_GRAPH) {
    const problems = [];
    for (const pkg of packages.values()) {
        for (const absolute of sourceFiles(pkg.dir)) {
            const file = toPosix(path.relative(root, absolute));
            for (const specifier of importsOf(readFileSync(absolute, "utf8"))) {
                if (specifier.startsWith(SCOPE)) {
                    const [folder, ...rest] = specifier.slice(SCOPE.length).split("/");
                    const subpath = rest.join("/");
                    const target = packages.get(folder);
                    if (target === undefined) {
                        problems.push({
                            kind: "unknown-dependency",
                            file,
                            target: folder,
                            message: `imports ${specifier}, which is not a workspace package`,
                        });
                        continue;
                    }
                    const testMayUse = isTestFile(file) && !dependsOn(graph, folder, pkg.folder);
                    if (folder !== pkg.folder && !pkg.declared.includes(folder) && !testMayUse)
                        problems.push({
                            kind: "undeclared",
                            file,
                            target: folder,
                            message: `imports ${specifier}, but ${pkg.name} does not declare ${SCOPE}${folder}`,
                        });
                    if (subpath === "src" || subpath.startsWith("src/"))
                        problems.push({
                            kind: "deep-import",
                            file,
                            target: folder,
                            message: `imports ${specifier}: a package's src/ is internal; import its entry or an exported subpath`,
                        });
                    else if (subpath !== "" && !isExported(target.exports, subpath))
                        problems.push({
                            kind: "deep-import",
                            file,
                            target: folder,
                            message: `imports ${specifier}, which ${target.name}'s package.json does not export`,
                        });
                } else if (specifier.startsWith(".")) {
                    const resolved = path.resolve(path.dirname(absolute), specifier);
                    const owner = packageOfPath(packages, resolved);
                    if (owner !== undefined && owner.folder !== pkg.folder)
                        problems.push({
                            kind: "deep-import",
                            file,
                            target: owner.folder,
                            message: `imports ${specifier}: a relative path into ${owner.name}; import ${owner.name} instead`,
                        });
                }
            }
        }
    }
    return problems;
}

/**
 * All violations not covered by an exception, plus exceptions that no longer match anything.
 * @param {string} root
 * @param {{ graph?: DependencyGraph; exceptions?: readonly BoundaryException[] }} [options]
 */
export function checkBoundaries(root, { graph = DEPENDENCY_GRAPH, exceptions = EXCEPTIONS } = {}) {
    const packages = readWorkspace(root);
    const found = [...checkGraph(packages, graph), ...checkImports(root, packages, graph)];
    const used = new Set();
    const violations = found.filter((problem) => {
        const exception = exceptions.find(
            (candidate) => candidate.target === problem.target && candidate.files.includes(problem.file),
        );
        if (exception === undefined) return true;
        used.add(`${problem.file} -> ${problem.target}`);
        return false;
    });
    for (const exception of exceptions)
        for (const file of exception.files)
            if (!used.has(`${file} -> ${exception.target}`))
                violations.push({
                    kind: "stale-exception",
                    file,
                    target: exception.target,
                    message: `the exception for ${file} -> ${exception.target} matches nothing; remove it`,
                });
    return { packages, violations };
}

function main() {
    const root = fileURLToPath(new URL("../", import.meta.url));
    if (process.argv.includes("--graph")) {
        for (const [name, deps] of Object.entries(DEPENDENCY_GRAPH))
            console.log(`${name.padEnd(14)} -> ${deps.join(", ") || "(none)"}`);
        return;
    }
    const { packages, violations } = checkBoundaries(root);
    if (violations.length === 0) {
        console.log(
            `Package boundaries hold: ${packages.size} packages, ${EXCEPTIONS.reduce((count, exception) => count + exception.files.length, 0)} file(s) with documented exceptions.`,
        );
        return;
    }
    for (const violation of violations)
        console.error(`${violation.file}: [${violation.kind}] ${violation.message}`);
    console.error(`\n${violations.length} package boundary violation(s). See scripts/check-boundaries.mjs.`);
    process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
