// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    command,
    type IDocument,
    isCancelableCommand,
} from "@chili3d/core";
import type { MeasuredVariableNode } from "../measurement/measuredVariableNode";
import type { MeasuredVariableData } from "../measurement/measurement";
import { editMeasuredVariable } from "../measurement/variableEditor";

@command({ key: "feature.variable", icon: "icon-tag" })
export class VariableCommand extends CancelableCommand {
    constructor(
        private readonly node?: MeasuredVariableNode,
        private readonly initial?: Pick<MeasuredVariableData, "mode" | "entities">,
    ) {
        super();
    }
    protected async executeAsync(): Promise<void> {
        this.controller = new AsyncController();
        await editMeasuredVariable(this.document, this.controller, this.node, this.initial);
    }
    static async createMeasured(
        document: IDocument,
        initial: Pick<MeasuredVariableData, "mode" | "entities">,
    ): Promise<void> {
        const app = document.application;
        if (app.activeView?.document !== document) return;
        if (app.executingCommand) {
            if (!isCancelableCommand(app.executingCommand)) return;
            await app.executingCommand.cancel();
        }
        const command = new VariableCommand(undefined, structuredClone(initial));
        app.executingCommand = command;
        try {
            await command.execute(app);
        } finally {
            if (app.executingCommand === command) app.executingCommand = undefined;
        }
    }
    static async edit(node: MeasuredVariableNode): Promise<void> {
        const app = node.document.application;
        if (app.executingCommand) {
            if (!isCancelableCommand(app.executingCommand)) return;
            await app.executingCommand.cancel();
        }
        const command = new VariableCommand(node);
        app.executingCommand = command;
        try {
            await command.execute(app);
        } finally {
            if (app.executingCommand === command) app.executingCommand = undefined;
        }
    }
}
