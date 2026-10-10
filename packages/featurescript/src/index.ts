// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// The FeatureScript engine. Language: `lang/` (lexer, parser, tree-walking interpreter,
// values). Std: `std/` + `nativeStd.ts` (the native TypeScript std) and `onshape/`
// (Onshape's own std source on `@` built-ins: pure ones in `pureBuiltins.ts`, modeling ones
// through the `StdBridge` in `bridge.ts`). Modeling: `context/` (the `FsContext` over the
// geometry kernel; the CAD around it plugs in through `IFsModelingHost`). `runtime.ts` is
// the surface the app uses. The language service and IDE pieces are `./ide`; internal
// modules are reachable as `@chili3d/featurescript/<path>`.

export * from "./context/fsContext";
export { entityDimension, inertiaTensor, type MassData, massData } from "./context/massProperties";
export * from "./context/modelingHost";
export { isQuery, query, resolveQuery, transientQuery } from "./context/queries";
export { FsSketch } from "./context/sketch";
export { sketchSpline } from "./context/sketchSpline";
export { interpolationDerivatives } from "./context/splineInterpolation";
export * from "./featureSpec";
export * from "./lang/errors";
export {
    type FeatureExport,
    Interpreter,
    type InterpreterOptions,
    isStdPath,
    type ModuleInstance,
    type ModuleResolver,
    type ModuleSource,
    type TableExport,
} from "./lang/interpreter";
export { parseExpression, parseProgram } from "./lang/parser";
export * from "./lang/values";
export { createNativeInterpreter } from "./nativeStd";
export { describeStatus, reportedStatus, type StatusKind } from "./onshape/featureBuiltins";
export {
    createOnshapeInterpreter,
    ONSHAPE_STD_PREFIX,
    type OnshapeInterpreterSetup,
    type OnshapeStdSource,
} from "./onshape/onshapeStd";
export { type OnshapeStdBundle, onshapeStdFromBundle } from "./onshape/stdBundle";
export * from "./runtime";
export {
    type AffineData,
    applyAffine,
    applyLinear,
    composeAffine,
    makePlaneData,
    type PlaneData,
    rotationAffine,
    type Vec3,
    vec,
} from "./std/geometry";
export { enumName } from "./std/registry";
export { expandTemplate } from "./std/table";
