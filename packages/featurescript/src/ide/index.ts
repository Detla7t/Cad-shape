// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// The FeatureScript language service (pure modules over the tolerant scanner — never the
// throwing lexer/parser) and its CodeMirror glue. CodeMirror makes this its own entry
// (`@chili3d/featurescript/ide`): import it lazily, so the editor stays out of the main chunk.

export * from "./analysis";
export * from "./completion";
export * from "./declarations";
export * from "./diagnostics";
export * from "./docComment";
export * from "./docView";
export * from "./extensions";
export * from "./folding";
export * from "./format";
export { default as ideStyle } from "./ide.module.css";
export * from "./language";
export * from "./navigation";
export * from "./outline";
export * from "./scanner";
export * from "./setup";
export * from "./stdIndex";
export * from "./stdViewer";
export * from "./symbols";
export * from "./theme";
