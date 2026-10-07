// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { installEvaluation } from "./context/evaluation";
import { installOperations } from "./context/operations";
import { installQueries } from "./context/queries";
import { installSketch } from "./context/sketch";
import { Interpreter, type ModuleResolver } from "./lang/interpreter";
import { installCore } from "./std/core";
import { installEnums } from "./std/enums";
import { installFeatureSupport } from "./std/feature";
import { installGeometry } from "./std/geometry";
import { StdBuilder } from "./std/registry";
import { installTables } from "./std/table";

/**
 * An interpreter on the native std: the std implemented directly in TypeScript, with
 * `onshape/std/...` imports as no-ops. Fast to create, and the kernel implementations of
 * its operations are what Onshape's std reaches through the `@` built-ins.
 */
export function createNativeInterpreter(
    setup: { print?: (text: string) => void; resolveModule?: ModuleResolver; maxSteps?: number } = {},
): Interpreter {
    const interpreter = new Interpreter({
        print: setup.print,
        resolveModule: setup.resolveModule,
        maxSteps: setup.maxSteps,
    });
    const std = new StdBuilder(interpreter);
    installEnums(std);
    installCore(std);
    installGeometry(std);
    installFeatureSupport(std);
    installQueries(std);
    installSketch(std);
    installOperations(std);
    installEvaluation(std);
    installTables(std);
    return interpreter;
}
