// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import * as core from "@chili3d/core";
import type { Tool, ToolResult } from "../llm/types";
import { getApplication } from "./documentContext";

/**
 * The escape hatch for anything no other tool covers: JavaScript evaluated in the page with the
 * application in scope. Offered only over the automation bridge (`availability: "external"`),
 * which the user enabled for this tab — never to the in-app assistant.
 */

const MAX_RESULT_CHARS = 100_000;
const MAX_DEPTH = 6;

/** JSON of any value: cycles, functions, Maps, Sets, errors and class instances made readable. */
export function describeValue(value: unknown): string {
    const seen = new WeakSet<object>();
    const convert = (item: unknown, depth: number): unknown => {
        if (item === undefined) return null;
        if (typeof item === "bigint") return `${item}n`;
        if (typeof item === "function") return `[Function ${item.name || "anonymous"}]`;
        if (typeof item === "symbol") return item.toString();
        if (item === null || typeof item !== "object") return item;
        if (seen.has(item)) return "[Circular]";
        if (depth >= MAX_DEPTH) return `[${item.constructor?.name ?? "Object"}]`;
        seen.add(item);
        if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
        if (typeof Element !== "undefined" && item instanceof Element) {
            return `[${item.tagName.toLowerCase()}${item.id ? `#${item.id}` : ""}]`;
        }
        if (item instanceof Map)
            return { "[Map]": [...item].slice(0, 200).map((entry) => convert(entry, depth + 1)) };
        if (item instanceof Set)
            return { "[Set]": [...item].slice(0, 200).map((entry) => convert(entry, depth + 1)) };
        if (Array.isArray(item)) return item.slice(0, 500).map((entry) => convert(entry, depth + 1));
        if (ArrayBuffer.isView(item))
            return `[${item.constructor.name} length ${(item as Uint8Array).length}]`;
        const result: Record<string, unknown> = {};
        const name = item.constructor?.name;
        if (name && name !== "Object") result["[class]"] = name;
        for (const key of Object.keys(item).slice(0, 200)) {
            try {
                result[key] = convert((item as Record<string, unknown>)[key], depth + 1);
            } catch (error) {
                result[key] = `[throws ${error instanceof Error ? error.message : error}]`;
            }
        }
        return result;
    };
    const json = JSON.stringify(convert(value, 0)) ?? "null";
    return json.length > MAX_RESULT_CHARS ? `${json.slice(0, MAX_RESULT_CHARS)}… [truncated]` : json;
}

type AsyncFunctionConstructor = new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as AsyncFunctionConstructor;
const PARAMETERS = ["app", "core", "view", "doc"];

/** An expression is returned as is; anything else runs as a function body (use `return`). */
function compile(code: string): (...args: unknown[]) => Promise<unknown> {
    try {
        return new AsyncFunction(...PARAMETERS, `return (${code}\n);`);
    } catch {
        return new AsyncFunction(...PARAMETERS, code);
    }
}

export function buildScriptTools(): Tool[] {
    return [
        {
            name: "evaluate_script",
            description:
                "Evaluate JavaScript in the page — the escape hatch for anything no other tool covers. In scope: app (the Application), core (the @chili3d/core module: Transaction, PubSub, CommandStore, OperationLog, XYZ, …), view (the active view), doc (its document), plus the page's window/document. An expression's value is returned; otherwise write a function body with return (await works). The value comes back as JSON; a data:image/… string comes back as an image. Wrap model edits in core.Transaction.execute(doc, name, () => …) so they are one undo step.",
            parameters: {
                type: "object",
                properties: {
                    code: { type: "string", description: "An expression, or a function body using return" },
                    timeoutMs: { type: "number", description: "Give up after this long (default 30000)" },
                },
                required: ["code"],
            },
            availability: "external",
            handler: async (args) =>
                evaluateScript(String(args["code"] ?? ""), Number(args["timeoutMs"] ?? 30_000)),
        },
    ];
}

export async function evaluateScript(code: string, timeoutMs = 30_000): Promise<ToolResult> {
    if (code.trim() === "") return { content: JSON.stringify({ error: "code is empty" }) };
    let run: (...args: unknown[]) => Promise<unknown>;
    try {
        run = compile(code);
    } catch (error) {
        return {
            content: JSON.stringify({
                error: `syntax error: ${error instanceof Error ? error.message : error}`,
            }),
        };
    }
    const app = getApplication();
    const view = app?.activeView;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`the script did not finish within ${timeoutMs} ms`)),
            Math.max(100, timeoutMs),
        );
    });
    try {
        const value = await Promise.race([run(app, core, view, view?.document), timeout]);
        if (typeof value === "string" && /^data:image\/[a-z+]+;base64,/.test(value)) {
            const mediaType = value.slice(5, value.indexOf(";"));
            return {
                content: JSON.stringify({ ok: true, image: mediaType }),
                images: [{ mediaType, data: value.slice(value.indexOf(",") + 1) }],
            };
        }
        return { content: `{"ok":true,"value":${describeValue(value)}}` };
    } catch (error) {
        return {
            content: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
                ...(error instanceof Error && error.stack ? { stack: error.stack.slice(0, 2000) } : {}),
            }),
        };
    } finally {
        clearTimeout(timer);
    }
}
