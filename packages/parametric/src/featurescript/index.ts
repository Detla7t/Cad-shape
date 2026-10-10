// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// The FeatureScript engine lives in `@chili3d/featurescript`; this is parametric's feature
// glue (studios, the featurescript feature, custom tables, the IDE host) plus the engine
// surface parametric has always re-exported. Loading it installs parametric's modeling host.
import "./modelingHost";

export * from "@chili3d/featurescript/context/fsContext";
export * from "@chili3d/featurescript/featureSpec";
export * from "@chili3d/featurescript/lang/errors";
export {
    type FeatureExport,
    Interpreter,
    type ModuleInstance,
    type ModuleSource,
    type TableExport,
} from "@chili3d/featurescript/lang/interpreter";
export { parseExpression, parseProgram } from "@chili3d/featurescript/lang/parser";
export {
    createOnshapeInterpreter,
    type OnshapeInterpreterSetup,
    type OnshapeStdSource,
} from "@chili3d/featurescript/onshape/onshapeStd";
export { type OnshapeStdBundle, onshapeStdFromBundle } from "@chili3d/featurescript/onshape/stdBundle";
export * from "@chili3d/featurescript/runtime";
export * from "./customTables";
export * from "./featureScriptFeature";
export * from "./featureStudioNode";
export * from "./insertFeature";
export * from "./studioCompiler";
export * from "./studioFiles";
export * from "./tableRuntime";
export { createFeatureScriptIde, showFeatureStudioEditor } from "./ui/featureStudioEditor";
export type { FeatureScriptIde, FeatureScriptIdeOptions } from "./ui/ide/featureScriptIde";
