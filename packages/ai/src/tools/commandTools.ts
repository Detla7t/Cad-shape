// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandKeys,
    CommandStore,
    Config,
    effectiveShortcuts,
    I18n,
    type I18nKeys,
    type IApplication,
    isCancelableCommand,
    OperationLog,
    PubSub,
} from "@chili3d/core";
import { currentStatusTip, messageSequence, recentMessages, trackUiEvents } from "../automation/uiEvents";
import type { Tool, ToolResult } from "../llm/types";
import { DRIVE_APP_GROUP } from "./automationGroup";
import { getApplication } from "./documentContext";
import { currentRibbon, ribbonLocations } from "./ribbonTools";

/**
 * Every registered command, and running one by id exactly as a ribbon button or hotkey does —
 * through `executeCommand` on the bus, so the CommandService logs it, opens its transaction
 * and undo works as for the user. A command that then waits for picks or input is reported as
 * waiting, with its prompt; the input tools answer it.
 */

const text = (value: unknown): ToolResult => ({ content: JSON.stringify(value) });

function translated(key: string): string | undefined {
    try {
        const value = I18n.translate(key as I18nKeys);
        return value && value !== key ? value : undefined;
    } catch {
        return undefined;
    }
}

function hotkeys(): Record<string, string> {
    try {
        const shortcuts = effectiveShortcuts(Config.instance.navigation3D, Config.instance.customShortcuts);
        return Object.fromEntries(
            Object.entries(shortcuts).map(([command, keys]) => [
                command,
                Array.isArray(keys) ? keys.join(" / ") : String(keys),
            ]),
        );
    } catch {
        return {};
    }
}

function commandKey(app: IApplication | undefined): string | undefined {
    const running = app?.executingCommand;
    return running ? CommandStore.getComandData(running)?.key : undefined;
}

/** The running command and what it is waiting for, as far as the app shows it. */
export function commandState(app: IApplication | undefined) {
    const command = commandKey(app);
    return {
        running: command !== undefined,
        command,
        prompt: command !== undefined ? currentStatusTip() : undefined,
        cancelable: app?.executingCommand !== undefined && isCancelableCommand(app.executingCommand),
        openOperations: OperationLog.openOperations().map((operation) => operation.operation),
    };
}

function listCommandsTool(): Tool {
    return {
        name: "list_commands",
        description:
            "List the registered commands: id, name in the user's language, where its ribbon buttons are, its hotkey, whether it runs without a document, and a toggle's state. query filters by id or name.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Case-insensitive filter on id or name" },
                limit: { type: "number", description: "At most this many (default 500)" },
            },
        },
        indexGroup: DRIVE_APP_GROUP,
        handler: async (args) => {
            const query = typeof args["query"] === "string" ? args["query"].toLowerCase() : undefined;
            const limit = Math.max(1, Number(args["limit"]) || 500);
            const ribbon = currentRibbon();
            const places = ribbon ? ribbonLocations(ribbon) : new Map<string, string[]>();
            const keys = hotkeys();
            const commands = CommandStore.getAllCommands()
                .map((data) => {
                    const toggle = data.toggle as { value?: unknown } | undefined;
                    return {
                        id: data.key,
                        name: translated(`command.${data.key}`),
                        ribbon: places.get(data.key),
                        hotkey: keys[data.key],
                        application: data.isApplicationCommand || undefined,
                        toggled: typeof toggle?.value === "boolean" ? toggle.value : undefined,
                    };
                })
                .filter(
                    (command) =>
                        query === undefined ||
                        command.id.toLowerCase().includes(query) ||
                        command.name?.toLowerCase().includes(query),
                )
                .sort((a, b) => a.id.localeCompare(b.id));
            return text({ total: commands.length, commands: commands.slice(0, limit) });
        },
    };
}

/** Polls `done` every 25 ms until it holds or `timeoutMs` passes; resolves whether it held. */
export async function waitUntil(
    done: () => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (!done()) {
        if (Date.now() >= end || signal?.aborted) return done();
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
}

/** The finished `command.execute` events after sequence `after`, newest last. */
function commandEventsAfter(after: number) {
    return OperationLog.snapshot()
        .filter((event) => event.sequence > after && event.operation === "command.execute")
        .map((event) => ({
            command: event.context["command"],
            outcome: event.outcome,
            durationMs: event.durationMs,
            ...(event.error ? { error: event.error.message } : {}),
        }));
}

function executeCommandTool(): Tool {
    return {
        name: "execute_command",
        description:
            "Run a command by id (see list_commands), exactly like its ribbon button or hotkey: same checks, same undo step. Waits up to waitMs for it to finish; a command still running then is waiting for picks or input — the result says so with its prompt, and view_pointer, ui_* or press_key (Escape cancels) answer it.",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "Command id, e.g. create.box or doc.save" },
                waitMs: { type: "number", description: "How long to wait for it to finish (default 1500)" },
            },
            required: ["command"],
        },
        indexGroup: DRIVE_APP_GROUP,
        handler: async (args, signal) => {
            const command = String(args["command"] ?? "");
            if (!CommandStore.getCommand(command)) {
                const close = CommandStore.getAllCommands()
                    .map((data) => data.key as string)
                    .filter((key) => key.includes(command.split(".").pop() ?? command))
                    .slice(0, 10);
                return text({ error: `no command "${command}"`, similar: close });
            }
            const app = getApplication();
            if (!app) return text({ error: "no application" });
            trackUiEvents();
            const lastEvent = OperationLog.snapshot().at(-1)?.sequence ?? 0;
            const lastMessage = messageSequence();
            PubSub.default.pub("executeCommand", command as CommandKeys);
            // CommandService checks asynchronously before it starts the command.
            await waitUntil(
                () => commandKey(app) !== undefined || commandEventsAfter(lastEvent).length > 0,
                300,
                signal,
            );
            const waitMs = Math.max(0, Number(args["waitMs"] ?? 1500));
            await waitUntil(() => app.executingCommand === undefined, waitMs, signal);
            const finished = commandEventsAfter(lastEvent);
            const messages = recentMessages(lastMessage).map((message) => `${message.kind}: ${message.text}`);
            const state = commandState(app);
            const status = state.running ? "waiting" : finished.length > 0 ? "finished" : "not_started";
            return text({
                status,
                ...(state.running
                    ? { running: state.command, prompt: state.prompt, cancelable: state.cancelable }
                    : {}),
                ...(finished.length ? { finished } : {}),
                ...(messages.length ? { messages } : {}),
                ...(status === "not_started"
                    ? {
                          hint: "the app refused to start it (no active document, or another command is running)",
                      }
                    : {}),
            });
        },
    };
}

function commandStateTool(): Tool {
    return {
        name: "get_command_state",
        description:
            "Read the running command, if any: its id, the prompt it shows (what it waits for), whether it can be cancelled, the operations still open, and the latest toasts and errors.",
        parameters: { type: "object", properties: {} },
        indexGroup: DRIVE_APP_GROUP,
        handler: async () => {
            trackUiEvents();
            const messages = recentMessages().map((message) => ({
                kind: message.kind,
                text: message.text,
                at: message.at,
            }));
            return text({
                ...commandState(getApplication()),
                lastCommand: getApplication()?.lastCommand,
                messages,
            });
        },
    };
}

function cancelCommandTool(): Tool {
    return {
        name: "cancel_command",
        description: "Cancel the running command, as Escape or starting another command does.",
        parameters: { type: "object", properties: {} },
        indexGroup: DRIVE_APP_GROUP,
        handler: async () => {
            const app = getApplication();
            const running = app?.executingCommand;
            if (!running) return text({ ok: true, cancelled: false, reason: "no command is running" });
            if (!isCancelableCommand(running))
                return text({ error: "the running command cannot be cancelled" });
            const command = commandKey(app);
            await running.cancel();
            await waitUntil(() => app.executingCommand === undefined, 2000);
            return text({
                ok: true,
                cancelled: true,
                command,
                stillRunning: app.executingCommand !== undefined,
            });
        },
    };
}

export function buildCommandTools(): Tool[] {
    trackUiEvents();
    return [listCommandsTool(), executeCommandTool(), commandStateTool(), cancelCommandTool()];
}
