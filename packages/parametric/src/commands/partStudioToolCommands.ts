// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, type IApplication, type ICommand, type IDocument, PubSub, Result } from "@chili3d/core";
import { type FeatureScriptFeatureData, featureHandler } from "../features/feature";
import {
    newOnshapeToolFeature,
    type OnshapeToolName,
    onshapeToolTarget,
} from "../featurescript/onshapeTools";
import type { ParametricBodyNode } from "../parametricBodyNode";
import { captureQueryPicks, isEmptyQuery } from "./featureScriptPickSession";

/**
 * A Part Studio toolbar tool, Onshape's way: the click opens the feature dialog on a new
 * feature (std's own, see `onshapeTools.ts`) with its first query box taking selections;
 * ✓ inserts it as one undo step, ✗ leaves nothing behind.
 */
abstract class PartStudioToolCommand implements ICommand {
    protected abstract readonly tool: OnshapeToolName;

    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        const created = stagePartStudioTool(document, this.tool);
        if (!created.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", created.error);
            return;
        }
        const { body, feature, pick } = created.value;
        // The dialog's edit session takes the command slot, which this command holds until it
        // returns: open it right after.
        setTimeout(() => PubSub.default.pub("editFeature", body, feature.id, { insert: feature, pick }));
    }
}

/**
 * The feature a tool click stages, and the box it opens on. Entities selected before the
 * click fill that first box when the box takes their kind — as Onshape's toolbar does with
 * a preselection — and the dialog opens with them selected and counted.
 */
export function stagePartStudioTool(
    document: IDocument,
    tool: OnshapeToolName,
): Result<{ body: ParametricBodyNode; feature: FeatureScriptFeatureData; pick?: string }> {
    const body = onshapeToolTarget(document);
    const created = newOnshapeToolFeature(document, tool, body);
    if (!created.isOk) return created;
    let { feature } = created.value;
    const first = featureHandler(feature.type)
        ?.parameters(feature, document)
        .find((parameter) => parameter.pick !== undefined);
    if (first?.pick !== undefined) {
        const preselected = captureQueryPicks(
            created.value.body,
            document.selection.getSelectedShapes(),
            first.pick.kinds,
        );
        if (!isEmptyQuery(preselected)) {
            feature = { ...feature, definition: { ...feature.definition, [first.key]: preselected } };
        }
    }
    return Result.ok({ body: created.value.body, feature, pick: first?.key });
}

@command({ key: "partStudio.fillet", icon: "icon-fillet" })
export class PartStudioFilletCommand extends PartStudioToolCommand {
    protected readonly tool = "filletTool";
}

@command({ key: "partStudio.chamfer", icon: "icon-chamfer" })
export class PartStudioChamferCommand extends PartStudioToolCommand {
    protected readonly tool = "chamferTool";
}

@command({ key: "partStudio.shell", icon: "icon-shell" })
export class PartStudioShellCommand extends PartStudioToolCommand {
    protected readonly tool = "shellTool";
}

@command({ key: "partStudio.boolean", icon: "icon-booleanFuse" })
export class PartStudioBooleanCommand extends PartStudioToolCommand {
    protected readonly tool = "booleanTool";
}

@command({ key: "partStudio.transform", icon: "icon-move" })
export class PartStudioTransformCommand extends PartStudioToolCommand {
    protected readonly tool = "transformTool";
}

@command({ key: "partStudio.linearPattern", icon: "icon-array" })
export class PartStudioLinearPatternCommand extends PartStudioToolCommand {
    protected readonly tool = "linearPatternTool";
}

@command({ key: "partStudio.circularPattern", icon: "icon-rotate" })
export class PartStudioCircularPatternCommand extends PartStudioToolCommand {
    protected readonly tool = "circularPatternTool";
}

@command({ key: "partStudio.mirror", icon: "icon-mirror" })
export class PartStudioMirrorCommand extends PartStudioToolCommand {
    protected readonly tool = "mirrorTool";
}
