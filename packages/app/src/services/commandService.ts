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
    Logger,
    OperationLog,
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

    private readonly onActiveViewChanged = async (view: IView | undefined) => {
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

        await this.executeAsync(command);
    };

    private async executeAsync(commandName: CommandKeys) {
        const commandCtor = CommandStore.getCommand(commandName)!;
        if (!commandCtor) {
            Logger.error(`Can not find ${commandName} command`);
            return;
        }

        const document = this.app.activeView?.document;
        const operation = OperationLog.begin("command.execute", {
            command: commandName,
            documentId: document?.id,
        });
        let failure: unknown;
        const command = new commandCtor();
        this.app.executingCommand = command;
        PubSub.default.pub("showProperties", this.app.activeView?.document!, []);

        await Promise.try(command.execute.bind(command), this.app)
            .catch((err) => {
                PubSub.default.pub("displayError", err as string);
                failure = err;
            })
            .finally(() => {
                operation.add({
                    nodeCount: document?.modelManager?.findNodes?.().length,
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
