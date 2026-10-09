import { resolve } from "node:path";
import { DefinePlugin } from "@rspack/core";
import { defineConfig } from "@rstest/core";
import packages from "./package.json" with { type: "json" };

const configDir = import.meta.dirname;

export default defineConfig({
    exclude: ["**/cpp/**", "**/rust/**", "**/.claude/**", "**/.next/**", "**/out/**"],
    coverage: {
        exclude: ["**/wasm/lib/**", "**/rs/lib/**", "**/test-utils/**"],
    },
    globals: true,
    setupFiles: [
        resolve(configDir, "packages/core/test-utils/setup.ts"),
        resolve(configDir, "packages/rs/test-utils/setup.ts"),
    ],
    testEnvironment: "happy-dom",
    tools: {
        // React components (`.tsx`) compile with the automatic JSX runtime, as in Next.js.
        swc: { jsc: { transform: { react: { runtime: "automatic" } } } },
        rspack: {
            plugins: [
                new DefinePlugin({
                    __APP_VERSION__: JSON.stringify(packages.version),
                    __DOCUMENT_VERSION__: JSON.stringify(packages.documentVersion),
                    __IS_PRODUCTION__: JSON.stringify(process.env.NODE_ENV === "production"),
                }),
            ],
            module: {
                rules: [
                    { test: /\.svg$/, type: "asset/source" },
                    // Mirror packages/web/next.config.mjs: load .wasm as an asset URL instead of a
                    // native webassembly module (which would instantiate at import time).
                    { test: /\.wasm$/, type: "asset" },
                    { test: /\.json\.gz$/, type: "asset/resource" },
                ],
            },
        },
    },
    resolve: {
        alias: {
            "./viewGizmo": resolve(configDir, "packages/three/test/viewGizmo.ts"),
        },
    },
    source: {
        decorators: {
            version: "legacy",
        },
    },
});
