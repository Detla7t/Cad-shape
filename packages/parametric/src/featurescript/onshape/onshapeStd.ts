// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Interpreter, type ModuleResolver } from "../lang/interpreter";
import { installOnshapeBuiltins } from "./builtins";

/**
 * Runs Onshape's own FeatureScript standard library (the MIT-licensed `onshape/std`
 * source) instead of the ambient native std: `onshape/std/...` imports load the real
 * modules, and everything they bottom out in is an `@` built-in from `./builtins`.
 */

/** Where the std source comes from — a directory of `.fs` files, a bundle, a fetch cache. */
export interface OnshapeStdSource {
    /** The source of `onshape/std/<file>`, undefined when there is no such file. */
    read(file: string): string | undefined;
    /** The std version, substituted for the `✨` placeholders a std mirror carries. */
    readonly version: number;
}

export interface OnshapeInterpreterSetup {
    readonly std: OnshapeStdSource;
    readonly print?: (text: string) => void;
    /** Resolves every non-std import (Feature Studios). */
    readonly resolveModule?: ModuleResolver;
    readonly maxSteps?: number;
}

export const ONSHAPE_STD_PREFIX = "onshape/std/";

export function createOnshapeInterpreter(setup: OnshapeInterpreterSetup): Interpreter {
    const resolveModule: ModuleResolver = (path) => {
        if (!path.startsWith(ONSHAPE_STD_PREFIX)) return setup.resolveModule?.(path);
        const source = setup.std.read(path.slice(ONSHAPE_STD_PREFIX.length));
        if (source === undefined) return undefined;
        return { path, source: withVersion(source, setup.std.version) };
    };
    const interpreter = new Interpreter({
        print: setup.print,
        resolveModule,
        maxSteps: setup.maxSteps,
        ambientStd: false,
    });
    installOnshapeBuiltins(interpreter, setup.std.version);
    return interpreter;
}

/** Mirrors replace the version in `FeatureScript N;` and `version : "N.0"` with `✨`. */
function withVersion(source: string, version: number): string {
    if (!source.includes("✨")) return source;
    return source
        .replace(/FeatureScript\s+✨\s*;/g, `FeatureScript ${version};`)
        .replace(/"✨"/g, `"${version}.0"`);
}
