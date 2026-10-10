// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TypecheckPlugin } from "../../scripts/typecheck-plugin.mjs";

const webDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(webDir, "../..");
const rootPackage = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));

/** Every workspace package: they ship TypeScript sources (legacy decorators, CSS modules), compiled here. */
const workspacePackages = readdirSync(join(rootDir, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
        try {
            const manifest = JSON.parse(
                readFileSync(join(rootDir, "packages", entry.name, "package.json"), "utf8"),
            );
            return manifest.name === "@chili3d/web" ? [] : [/** @type {string} */ (manifest.name)];
        } catch {
            return [];
        }
    });

/**
 * @typedef {{ loader?: string, options?: { modules?: { mode?: string } }, oneOf?: Rule[], use?: Rule[] | Rule, rules?: Rule[] }} Rule
 */

/**
 * The CSS modules were written for Rspack's `css/auto`, which lets a module also style plain
 * elements (`svg`, `input`, `:root[theme=…]`). Next's css-loader runs modules in `pure` mode and
 * rejects those selectors; `local` mode keeps class hashing and accepts them.
 */
/** @param {readonly unknown[]} rules */
function allowGlobalSelectorsInModules(rules) {
    for (const item of rules) {
        if (item === null || typeof item !== "object") continue;
        const rule = /** @type {Rule} */ (item);
        if (rule.loader?.includes("css-loader") && rule.options?.modules?.mode === "pure") {
            rule.options.modules.mode = "local";
        }
        for (const nested of [
            rule.oneOf,
            rule.rules,
            Array.isArray(rule.use) ? rule.use : rule.use && [rule.use],
        ]) {
            if (nested) allowGlobalSelectorsInModules(nested);
        }
    }
}

/** @type {import("next").NextConfig} */
const nextConfig = {
    // The CAD runs entirely in the browser (WebAssembly kernels, IndexedDB): a static export
    // deploys anywhere the Rspack build did (`dist/`, the nginx image).
    output: "export",
    trailingSlash: true,
    reactStrictMode: true,
    // The repository's CLAUDE.md/AGENTS.md describe the workspace; no generated per-app copy.
    agentRules: false,
    transpilePackages: workspacePackages,
    images: { unoptimized: true, disableStaticImages: true },
    experimental: { externalDir: true },
    // The dev server only answers its own host (`localhost`); the app is also opened (and driven
    // by browser tooling) at 127.0.0.1, whose HMR socket Next would otherwise block.
    allowedDevOrigins: ["127.0.0.1"],
    // The workspace is type-checked as one project (the root tsconfig, the compiler `npm run
    // typecheck` picks): by `TypecheckPlugin` in webpack builds, by `scripts/dev.mjs` beside the
    // Turbopack dev server. Next's own check would cover only this app.
    typescript: { ignoreBuildErrors: true },
    // Plain values: unlike webpack's DefinePlugin (code snippets), Next stringifies each value
    // itself for both bundlers — a JSON.stringify here would embed quotes in the strings (the
    // builds of 9 October 2026 wrote `'"0.7.1"'` into documents, the title and plugin checks).
    compiler: {
        define: {
            __APP_VERSION__: rootPackage.version,
            __DOCUMENT_VERSION__: rootPackage.documentVersion,
            __IS_PRODUCTION__: process.env.NODE_ENV === "production",
        },
    },
    // `npm run dev` runs Turbopack (seconds to a working app, cached between runs in .next/);
    // these rules mirror the webpack ones below.
    turbopack: {
        root: rootDir,
        rules: {
            "*.svg": { type: "raw" },
            "*.wasm": { type: "asset" },
            "*.cur": { type: "asset" },
            "*.jpg": { type: "asset" },
            "*.gz": { type: "asset" },
        },
        resolveAlias: {
            // Emscripten glue (LibreDWG in @chili3d/documents) imports Node's `module` only under Node.
            module: { browser: "./src/emptyModule.js" },
        },
        ignoreIssue: [
            // The OCCT glue computes its directory with `new URL(".", import.meta.url)` (in a
            // try/catch, unused: the .wasm is found by its own `new URL`), which Turbopack tries
            // to resolve as an asset. The glue is a hashed build artifact, so it is not patched.
            { path: "**/packages/wasm/lib/chili-wasm.js", title: /Module not found/ },
        ],
    },
    webpack(config, { isServer }) {
        allowGlobalSelectorsInModules(config.module.rules);
        config.module.rules.push(
            // Icon sheets are inlined as markup.
            { test: /\.svg$/, type: "asset/source" },
            // Kernels, cursors, images and Onshape's std bundle are files, imported as their URL.
            {
                test: /\.(wasm|cur|jpg)$/,
                type: "asset/resource",
                generator: { filename: "static/media/[name].[hash][ext]" },
            },
            {
                test: /\.json\.gz$/,
                type: "asset/resource",
                generator: { filename: "static/media/[name].[hash][ext]" },
            },
        );
        if (!isServer) {
            // Type errors fail the build (and show in dev), as they did under Rspack: once, on the client compiler.
            config.plugins.push(new TypecheckPlugin(rootDir));
            // Emscripten glue (LibreDWG in @chili3d/documents) imports Node's `module` only under Node.
            config.resolve.fallback = { ...config.resolve.fallback, module: false };
        }
        return config;
    },
};

export default nextConfig;
