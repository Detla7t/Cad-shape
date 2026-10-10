// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { OperationLog } from "@chili3d/core";
import { nextFrame } from "../automation/domInput";
import { findElement, TARGET_PROPERTIES, targetSpecOf } from "../automation/uiElements";
import type { Tool, ToolResult } from "../llm/types";
import { DRIVE_APP_GROUP } from "./automationGroup";
import { commandState } from "./commandTools";
import { getApplication } from "./documentContext";

/**
 * Waits until a condition holds, so a remote client can act and then verify without guessing
 * delays: the app is idle (no rebuild, transaction or sketch commit in progress), the running
 * command finished, an element appeared or went away, text shows, or a log event was recorded.
 */

const text = (value: unknown): ToolResult => ({ content: JSON.stringify(value) });

const CONDITIONS = ["idle", "command_finished", "element", "element_gone", "text", "log_event"] as const;
type Condition = (typeof CONDITIONS)[number];

/**
 * Operations that stay open while the user works (a command waiting for picks, a sketch
 * session) — and the automation call that is waiting right now.
 */
const LONG_LIVED = new Set(["command.execute", "sketch.session", "automation.call"]);

export function isIdle(): boolean {
    return OperationLog.openOperations().every((operation) => LONG_LIVED.has(operation.operation));
}

function pageText(): string {
    const body = document.body as HTMLElement | null;
    return (body?.innerText || body?.textContent || "").replace(/\s+/g, " ").toLowerCase();
}

/** A check for the condition, or the message saying why the arguments do not make one. */
function check(condition: Condition, args: Record<string, unknown>): (() => boolean) | string {
    switch (condition) {
        case "idle":
            return isIdle;
        case "command_finished":
            return () => getApplication()?.executingCommand === undefined;
        case "element":
        case "element_gone": {
            const spec = targetSpecOf(args);
            if (!spec) return `${condition} needs ref, selector, label or text`;
            const present = () => typeof findElement({ ...spec, index: spec.index ?? 0 }) !== "string";
            return condition === "element" ? present : () => !present();
        }
        case "text": {
            const wanted =
                typeof args["text"] === "string" ? args["text"].replace(/\s+/g, " ").toLowerCase() : "";
            if (!wanted) return "text needs the text to wait for";
            return () => pageText().includes(wanted);
        }
        case "log_event": {
            const prefix = typeof args["operation"] === "string" ? args["operation"] : "";
            const after = Number(args["afterSequence"] ?? OperationLog.snapshot().at(-1)?.sequence ?? 0);
            return () =>
                OperationLog.snapshot().some(
                    (event) =>
                        event.sequence > after &&
                        event.operation.startsWith(prefix) &&
                        (args["outcome"] === undefined || event.outcome === args["outcome"]),
                );
        }
    }
}

export function buildWaitTools(): Tool[] {
    return [
        {
            name: "wait_for",
            description:
                "Wait until a condition holds, up to timeoutMs (default 10000): idle (no rebuild, transaction or sketch commit in progress), command_finished, element / element_gone (ref, selector, label or text), text (shows anywhere on the page), log_event (an OperationLog event with this operation prefix — and outcome — after afterSequence, default now). The condition must hold for stableMs (default 100). Reports whether it held and how long it took.",
            parameters: {
                type: "object",
                properties: {
                    condition: { type: "string", enum: [...CONDITIONS] },
                    ...TARGET_PROPERTIES,
                    operation: { type: "string", description: "log_event: operation name prefix" },
                    outcome: { type: "string", enum: ["success", "cancelled", "error", "rolled_back"] },
                    afterSequence: {
                        type: "number",
                        description: "log_event: only events after this sequence",
                    },
                    timeoutMs: {
                        type: "number",
                        description: "Give up after this long (default 10000, max 120000)",
                    },
                    stableMs: { type: "number", description: "How long it must keep holding (default 100)" },
                },
                required: ["condition"],
            },
            indexGroup: DRIVE_APP_GROUP,
            handler: async (args, signal) => {
                const condition = args["condition"] as Condition;
                if (!CONDITIONS.includes(condition)) {
                    return text({ error: `condition must be one of ${CONDITIONS.join("|")}` });
                }
                const holds = check(condition, args);
                if (typeof holds === "string") return text({ error: holds });
                const timeoutMs = Math.max(0, Math.min(120_000, Number(args["timeoutMs"] ?? 10_000)));
                const stableMs = Math.max(0, Math.min(5000, Number(args["stableMs"] ?? 100)));
                const started = Date.now();
                let since: number | undefined;
                while (true) {
                    const now = Date.now();
                    if (holds()) {
                        since ??= now;
                        if (now - since >= stableMs) {
                            await nextFrame();
                            if (holds()) {
                                return text({ ok: true, condition, waitedMs: Date.now() - started });
                            }
                            since = undefined;
                        }
                    } else since = undefined;
                    if (now - started >= timeoutMs || signal?.aborted) {
                        return text({
                            ok: false,
                            condition,
                            error: `timed out after ${timeoutMs} ms`,
                            openOperations: OperationLog.openOperations(),
                            command: commandState(getApplication()),
                        });
                    }
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
            },
        },
    ];
}
