// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { PROJECT_ROOT, runCompiler } from "./typescript-compiler.mjs";

/** Rspack and the CLI use the same compiler selection and failure policy. SWC still emits browser JS. */
export class TypecheckPlugin {
    constructor(root = PROJECT_ROOT) {
        this.root = root;
    }

    /** @param {import("@rspack/core").Compiler} compiler */
    apply(compiler) {
        const name = "ChiliTypecheckPlugin";
        let active;
        const cancel = () => active?.abort();
        compiler.hooks.watchClose.tap(name, cancel);
        compiler.hooks.shutdown.tap(name, cancel);
        // make is parallel: type checking runs alongside compilation, and blocks completion on errors.
        compiler.hooks.make.tapPromise(name, async (compilation) => {
            active = new AbortController();
            const config = resolve(this.root, "tsconfig.json");
            compilation.fileDependencies.add(config);
            try {
                const result = await runCompiler(["--noEmit", "--project", config, "--listFiles"], {
                    root: this.root,
                    signal: active.signal,
                });
                const diagnostics = [];
                for (const line of result.stdout.split(/\r?\n/)) {
                    if (isAbsolute(line) && !/\bTS\d+:/.test(line)) {
                        compilation.fileDependencies.add(line);
                        const local = relative(this.root, line);
                        if (!local.startsWith("..") && !local.split(sep).includes("node_modules")) {
                            // Includes tests and newly created files outside the browser's module graph.
                            compilation.contextDependencies.add(dirname(line));
                        }
                    } else diagnostics.push(line);
                }
                if (result.status !== 0) {
                    compilation.errors.push(
                        new Error(
                            `TypeScript (${result.backend}):\n${diagnostics.join("\n")}\n${result.stderr}`,
                        ),
                    );
                }
            } catch (error) {
                compilation.errors.push(new Error(`TypeScript: ${String(error)}`));
            } finally {
                active = undefined;
            }
        });
    }
}
