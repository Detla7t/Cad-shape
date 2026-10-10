// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, Result } from "@chili3d/core";
import { type OnshapeStdSource, providedOnshapeStd } from "@chili3d/featurescript";
import type { FeatureScriptFeatureData } from "../features/feature";
import { ParametricBodyNode } from "../parametricBodyNode";
import { FeatureStudioNode } from "./featureStudioNode";
import { newFeatureScriptFeature } from "./insertFeature";
import { registerStudioProvider } from "./studioCompiler";

/**
 * Part Studio tools that ARE Onshape's own features: each export of the tools studio is
 * std's feature itself (an alias), so the dialog the feature panel builds from its
 * precondition has Onshape's fields, order, defaults, conditional rows and operation tabs,
 * and the result is what std computes. Transform is the one std feature not exported as a
 * value (a function wrapping a private `defineFeature`), so its wrapper carries std's own
 * precondition text and calls the exported function.
 */
export interface OnshapeTool {
    /** The export of the tools studio — the feature's key in a body. */
    readonly featureName: string;
    /** Onshape's feature name, shown in the dialog title and the feature list. */
    readonly displayName: string;
    /** The std feature the export aliases; undefined for the generated Transform wrapper. */
    readonly std?: string;
    readonly icon: string;
}

export const ONSHAPE_TOOLS = [
    { featureName: "filletTool", displayName: "Fillet", std: "fillet", icon: "icon-fillet" },
    { featureName: "chamferTool", displayName: "Chamfer", std: "chamfer", icon: "icon-chamfer" },
    { featureName: "shellTool", displayName: "Shell", std: "shell", icon: "icon-shell" },
    { featureName: "booleanTool", displayName: "Boolean", std: "booleanBodies", icon: "icon-booleanFuse" },
    { featureName: "transformTool", displayName: "Transform", icon: "icon-move" },
    {
        featureName: "linearPatternTool",
        displayName: "Linear pattern",
        std: "linearPattern",
        icon: "icon-array",
    },
    {
        featureName: "circularPatternTool",
        displayName: "Circular pattern",
        std: "circularPattern",
        icon: "icon-rotate",
    },
    { featureName: "mirrorTool", displayName: "Mirror", std: "mirror", icon: "icon-mirror" },
] as const satisfies readonly OnshapeTool[];

export type OnshapeToolName = (typeof ONSHAPE_TOOLS)[number]["featureName"];

export const ONSHAPE_TOOLS_STUDIO_NAME = "Part Studio tools";

/**
 * The id tool features reference as their studio. It is not a node id: the studio is
 * provided to the compiler (`registerStudioProvider`), so a document using the tools has no
 * extra tab, no tree row and no undo step for it — as Onshape's toolbar leaves nothing behind.
 */
export const ONSHAPE_TOOLS_STUDIO_ID = "onshape-part-studio-tools";

let cachedSource: { std: OnshapeStdSource; source: string } | undefined;

/** The tools studio source for the loaded std; undefined when std is missing or changed shape. */
export function onshapeToolsSource(
    std: OnshapeStdSource | undefined = providedOnshapeStd(),
): string | undefined {
    if (std === undefined) return undefined;
    if (cachedSource?.std === std) return cachedSource.source;
    const transform = transformWrapper(std.read("transformCopy.fs"));
    if (transform === undefined) return undefined;
    const version = std.version;
    // Toolbar order, so the studio lists its features the way the toolbar shows them.
    const declarations = ONSHAPE_TOOLS.map((tool) =>
        "std" in tool
            ? `annotation { "Feature Type Name" : "${tool.displayName}" }\nexport const ${tool.featureName} = ${tool.std};`
            : transform,
    );
    const source = [
        `FeatureScript ${version};`,
        `import(path : "onshape/std/geometry.fs", version : "${version}.0");`,
        "",
        "// Onshape's own features, exposed as Chili3d Part Studio tools. Generated — edits are kept",
        "// in this document, but the toolbar inserts features from a fresh copy of this studio.",
        ...declarations,
        "",
    ].join("\n");
    cachedSource = { std, source };
    return source;
}

/**
 * std's Transform precondition and defaults around a call of the exported `transform`.
 * Read out of `transformCopy.fs` by bracket matching, skipping strings and comments.
 */
function transformWrapper(file: string | undefined): string | undefined {
    if (file === undefined) return undefined;
    const text = file.replace(/\r\n/g, "\n");
    const start = text.indexOf(
        "const fTransform = defineFeature(function(context is Context, id is Id, definition is map)",
    );
    if (start < 0) return undefined;
    const preconditionAt = text.indexOf("precondition", start);
    const preconditionOpen = text.indexOf("{", preconditionAt);
    const preconditionClose = matchingBrace(text, preconditionOpen);
    if (preconditionAt < 0 || preconditionClose === undefined) return undefined;
    const bodyOpen = text.indexOf("{", preconditionClose + 1);
    const bodyClose = matchingBrace(text, bodyOpen);
    if (bodyClose === undefined) return undefined;
    // After the body: either `);` or `, { defaults });`.
    const rest = text.slice(bodyClose + 1);
    const defaults = /^\s*,\s*(\{)/.exec(rest);
    let defaultsText = "";
    if (defaults !== null) {
        const open = bodyClose + 1 + defaults.index + defaults[0].length - 1;
        const close = matchingBrace(text, open);
        if (close === undefined) return undefined;
        defaultsText = `, ${text.slice(open, close + 1)}`;
    }
    const precondition = text.slice(preconditionAt, preconditionClose + 1);
    return [
        'annotation { "Feature Type Name" : "Transform" }',
        "export const transformTool = defineFeature(function(context is Context, id is Id, definition is map)",
        `    ${precondition}`,
        "    {",
        '        transform(context, id + "transform", definition);',
        `    }${defaultsText});`,
    ].join("\n");
}

/** The index of the `}` closing the `{` at `open`, skipping strings and comments. */
function matchingBrace(text: string, open: number): number | undefined {
    if (open < 0 || text[open] !== "{") return undefined;
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
        } else if (c === "/" && text[i + 1] === "/") {
            i = text.indexOf("\n", i);
            if (i < 0) return undefined;
        } else if (c === "/" && text[i + 1] === "*") {
            i = text.indexOf("*/", i + 2);
            if (i < 0) return undefined;
            i++;
        } else if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return undefined;
}

const studios = new WeakMap<IDocument, { std: OnshapeStdSource; studio: FeatureStudioNode }>();

/**
 * The tools studio for `document` under the loaded std: a detached `FeatureStudioNode`
 * (never added to the model tree) carrying the generated source, rebuilt when the std
 * changes. Undefined while no std is loaded.
 */
export function onshapeToolsStudio(document: IDocument): FeatureStudioNode | undefined {
    const std = providedOnshapeStd();
    const source = onshapeToolsSource(std);
    if (std === undefined || source === undefined) return undefined;
    const cached = studios.get(document);
    if (cached?.std === std) return cached.studio;
    const studio = new FeatureStudioNode({
        document,
        id: ONSHAPE_TOOLS_STUDIO_ID,
        name: ONSHAPE_TOOLS_STUDIO_NAME,
        source,
    });
    studios.set(document, { std, studio });
    return studio;
}

registerStudioProvider((document, studioId) =>
    studioId === ONSHAPE_TOOLS_STUDIO_ID ? onshapeToolsStudio(document) : undefined,
);

/**
 * The Part Studio a tool works in: the selected parametric body, the body of a selected
 * entity, else the most recent body — Onshape's tools act on the Part Studio, where
 * Chili3d's parts live in parametric bodies.
 */
export function onshapeToolTarget(document: IDocument): ParametricBodyNode | undefined {
    const selected = [
        ...document.selection.getSelectedNodes(),
        ...document.selection.getSelectedShapes().map((shape) => shape.owner.node),
    ].find((node) => node instanceof ParametricBodyNode);
    if (selected instanceof ParametricBodyNode) return selected;
    const bodies = document.modelManager.findNodes(
        (node) => node instanceof ParametricBodyNode,
    ) as ParametricBodyNode[];
    return bodies.at(-1);
}

/**
 * A new, not yet inserted feature of `tool` with std's defaults — the payload a feature
 * dialog stages (`FeatureEditOptions.insert`) — and the body it goes into.
 */
export function newOnshapeToolFeature(
    document: IDocument,
    tool: OnshapeToolName,
    body: ParametricBodyNode | undefined = onshapeToolTarget(document),
): Result<{ body: ParametricBodyNode; feature: FeatureScriptFeatureData }> {
    if (body === undefined) return Result.err("Create a part first: there is no Part Studio body to work in");
    const studio = onshapeToolsStudio(document);
    if (studio === undefined) return Result.err("The Onshape standard library has not loaded");
    const feature = newFeatureScriptFeature(document, studio, tool);
    if (!feature.isOk) return Result.err(feature.error);
    const icon = ONSHAPE_TOOLS.find((entry) => entry.featureName === tool)?.icon;
    return Result.ok({ body, feature: { ...feature.value, toolIcon: icon } });
}
