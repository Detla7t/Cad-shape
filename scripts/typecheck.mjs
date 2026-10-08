// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { compilerArguments, runCompiler } from "./typescript-compiler.mjs";

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
    const { compiler, args } = compilerArguments(process.argv.slice(2));
    const result = await runCompiler(["--noEmit", ...args], { compiler, signal: controller.signal });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status;
} catch (error) {
    console.error(String(error));
    process.exitCode = 1;
} finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
}
