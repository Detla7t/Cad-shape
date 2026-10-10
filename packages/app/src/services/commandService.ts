// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    CancelableCommand,
    type CommandKeys,
    CommandStore,
    type IApplication,
    type IService,
    type IView,
    isCancelableCommand,
    type LogContext,
    Logger,
    OperationLog,
    PropertyUtils,
    PubSub,
} from "@chili3d/core";

export class CommandService implements IService {
    private _checking: boolean = false;
    private _app: IApplication | undefined;

    private get app(): IApplication {
        if (this._app === undefined) {
            throw new Error("Executor is not initialized");
        }
        return this._app;
    }

    start(): void {
        PubSub.default.sub("executeCommand", this.executeCommand);
        PubSub.default.sub("activeViewChanged", this.onActiveViewChanged);
        Logger.info(`${CommandService.name} started`);
    }

    stop(): void {
        PubSub.default.remove("executeCommand", this.executeCommand);
        PubSub.default.remove("activeViewChanged", this.onActiveViewChanged);
        Logger.info(`${CommandService.name} stoped`);
    }

    register(app: IApplication) {
        this._app = app;
        Logger.info(`${CommandService.name} registed`);
    }

    private readonly onActiveViewChanged = async (_view: IView | undefined) => {
        if (this.app.executingCommand && isCancelableCommand(this.app.executingCommand))
            await this.app.executingCommand.cancel();
    };

    private readonly executeCommand = async (commandName: CommandKeys) => {
        let command = commandName === "special.last" ? this.app.lastCommand : commandName;
        if (command) {
            command =
                this.app.activeView?.document.visual?.eventHandler?.resolveCommand?.(command) ?? command;
            command = CommandStore.resolveCommand(command, this.app);
        }
        if (!command || !(await this.canExecute(command))) return;

        await this.executeAsync(command, commandName);
    };

    private async executeAsync(commandName: CommandKeys, requested: CommandKeys = commandName) {
        const commandCtor = CommandStore.getCommand(commandName)!;
        if (!commandCtor) {
            Logger.error(`Can not find ${commandName} command`);
            return;
        }

        const document = this.app.activeView?.document;
        // what was asked for, what it resolved to, and what was selected when it started —
        // the three things that decide which flow a command takes
        const operation = OperationLog.begin("command.execute", {
            command: commandName,
            ...(requested === commandName ? {} : { requestedCommand: requested }),
            documentId: document?.id,
            selectedNodesAtStart: document?.selection.getSelectedNodes().length,
            selectedShapesAtStart: document?.selection.getSelectedShapes().length,
            nodesAtStart: document?.modelManager?.findNodes?.().length,
        });
        let failure: unknown;
        const command = new commandCtor();
        this.app.executingCommand = command;
        PubSub.default.pub("showProperties", document!, []);

        await Promise.try(command.execute.bind(command), this.app)
            .catch((err) => {
                PubSub.default.pub("displayError", err as string);
                failure = err;
            })
            .finally(() => {
                operation.add({
                    nodeCount: document?.modelManager?.findNodes?.().length,
                    ...commandParameters(command),
                });
                operation.finish(
                    failure !== undefined
                        ? "error"
                        : command instanceof CancelableCommand && command.isCanceled
                          ? "cancelled"
                          : "success",
                    failure,
                );
                this.app.lastCommand = commandName;
                this.app.executingCommand = undefined;
            });
    }

    private async canExecute(commandName: CommandKeys) {
        if (this._checking) return false;
        this._checking = true;
        const result = await this.checking(commandName);
        this._checking = false;
        return result;
    }

    private async checking(commandName: CommandKeys) {
        const commandData = CommandStore.getComandData(commandName);
        if (!commandData?.isApplicationCommand && this.app.activeView === undefined) {
            Logger.error("No active document");
            return false;
        }
        if (!this.app.executingCommand) {
            return true;
        }
        if (CommandStore.getComandData(this.app.executingCommand)?.key === commandName) {
            PubSub.default.pub("showToast", "toast.command.{0}excuting", commandName);
            return false;
        }
        if (isCancelableCommand(this.app.executingCommand)) {
            await this.app.executingCommand.cancel();
            return true;
        }
        return false;
    }
}

/**
 * The command's declared parameters as `param.<name>` fields — the options the user set
 * (depth, operation, connected …) are what make a run reproducible. Only scalar values are
 * recorded; a parameter whose getter throws is skipped.
 */
export function commandParameters(command: object): LogContext {
    const values: LogContext = {};
    for (const property of PropertyUtils.getProperties(command)) {
        try {
            const value = (command as Record<string, unknown>)[property.name];
            if (typeof value === "function" || value === undefined || value === null) continue;
            if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
                values[`param.${property.name}`] = typeof value === "string" ? value.slice(0, 200) : value;
            else values[`param.${property.name}`] = String(value).slice(0, 200);
        } catch {
            // a parameter that cannot be read is not worth failing the log for
        }
    }
    return values;
}
