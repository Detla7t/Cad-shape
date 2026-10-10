// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Tool, ToolAudience } from "../llm/types";
import { buildSkillTool } from "../skills";
import { buildAskUserTool } from "./askUser";
import { buildCameraTools } from "./cameraTools";
import { buildCapabilityTools } from "./capabilityEngine";
import { buildCommandTools } from "./commandTools";
import { buildFileTools } from "./fileTools";
import { buildInputTools } from "./inputTools";
import { buildNodeTools } from "./nodeTools";
import { buildParametricTools } from "./parametricTools";
import { buildPropertyTools } from "./propertyTools";
import { buildReadTools } from "./readTools";
import { buildRibbonTools } from "./ribbonTools";
import { buildScriptTools } from "./scriptTools";
import { buildSelectionTools } from "./selectionTools";
import { buildStateTools } from "./stateTools";
import { buildUiTools } from "./uiTools";
import { buildVariableTools } from "./variableTools";
import { buildViewTools } from "./viewTools";
import { buildWaitTools } from "./waitTools";

/**
 * The one tool registry: the in-app assistant (`assistant`, the default) and the automation
 * bridge (`automation`) build their lists from it. A tool marked `availability: "external"`
 * (script evaluation) is only in the automation list.
 */
export function buildTools(audience: ToolAudience = "assistant"): Tool[] {
    const tools = registry();
    return audience === "automation" ? tools : tools.filter((tool) => tool.availability !== "external");
}

function registry(): Tool[] {
    return [
        ...buildReadTools(),
        ...buildRibbonTools(),
        ...buildNodeTools(),
        ...buildPropertyTools(),
        ...buildViewTools(),
        ...buildSelectionTools(),
        ...buildFileTools(),
        ...buildCapabilityTools(),
        buildSkillTool(),
        // Everything below is appended, never inserted: the API matches the cached prompt
        // prefix in the order tools -> system -> messages, so putting a tool anywhere but
        // the end invalidates the tools prefix of every conversation already in flight.
        ...buildParametricTools(),
        ...buildVariableTools(),
        buildAskUserTool(),
        // Driving the app like the user does: camera, commands, input, any UI element, state.
        ...buildCameraTools(),
        ...buildCommandTools(),
        ...buildInputTools(),
        ...buildUiTools(),
        ...buildStateTools(),
        ...buildWaitTools(),
        ...buildScriptTools(),
    ];
}
