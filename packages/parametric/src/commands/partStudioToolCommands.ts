// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, type IApplication, type ICommand, PubSub } from "@chili3d/core";
import { featureHandler } from "../features/feature";
import { newOnshapeToolFeature, type OnshapeToolName } from "../featurescript/onshapeTools";

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
        const created = newOnshapeToolFeature(document, this.tool);
        if (!created.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", created.error);
            return;
        }
        const { body, feature } = created.value;
        const firstPick = featureHandler(feature.type)
            ?.parameters(feature, document)
            .find((parameter) => parameter.pick !== undefined)?.key;
        PubSub.default.pub("editFeature", body, feature.id, { insert: feature, pick: firstPick });
    }
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
