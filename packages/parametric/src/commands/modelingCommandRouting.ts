// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type CommandKeys, CommandStore } from "@chili3d/core";
import { ParametricBodyNode } from "../parametricBodyNode";
import { SketchNode } from "../sketch/sketchNode";

const modelingFeatures: Partial<Record<CommandKeys, CommandKeys>> = {
    "create.extrude": "feature.extrude",
    "create.revol": "feature.revolve",
    "create.loft": "feature.loft",
    "modify.fillet": "feature.fillet",
    "modify.chamfer": "feature.chamfer",
    "boolean.join": "feature.fuse",
    "boolean.cut": "feature.cut",
    "boolean.common": "feature.common",
};

// Old toolbar layouts and search results must not replace a parametric body with a frozen solid.
CommandStore.registerResolver((key, app) => {
    const mapped = modelingFeatures[key],
        model = app.activeView?.document;
    if (!mapped || !model || !CommandStore.getCommand(mapped)) return key;
    const selected = [
        ...model.selection.getSelectedNodes(),
        ...model.selection.getSelectedShapes().map((shape) => shape.owner.node),
    ];
    return selected.length === 0 ||
        selected.some((node) => node instanceof ParametricBodyNode || node instanceof SketchNode)
        ? mapped
        : key;
});
