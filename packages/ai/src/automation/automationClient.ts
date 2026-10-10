// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Observable, OperationLog } from "@chili3d/core";
import type { ImagePart, Tool } from "../llm/types";

/**
 * The tab's side of the automation bridge (`scripts/automation-bridge.mjs`): the tab connects
 * OUT to the bridge on 127.0.0.1 — an event stream down (`hello`, then `call`s), fetch up
 * (`/tab/register` with its tools, `/tab/result` per call) — and runs each call through the
 * shared tool registry, exactly as the in-app assistant would. It reconnects with backoff while
 * enabled. Every call is one `automation.call` OperationLog event, with its source.
 */

export const DEFAULT_AUTOMATION_URL = "http://127.0.0.1:7782";

export interface AutomationCall {
    readonly id: string;
    readonly tool: string;
    readonly args: Record<string, unknown>;
    /** Who sent it through the bridge: "mcp" (Claude Code) or "http" (a shell). */
    readonly client?: string;
}

export interface AutomationResult {
    content: string;
    images?: ImagePart[];
    isError: boolean;
}

/** Whether a tool's JSON answer reports a failure (the registry's tools answer `{ error }`). */
function reportsError(content: string): boolean {
    if (!content.startsWith("{")) return false;
    try {
        const value = JSON.parse(content) as Record<string, unknown>;
        return (
            typeof value === "object" && value !== null && "error" in value && value["error"] !== undefined
        );
    } catch {
        return false;
    }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs one call against `tools` and records it; never throws. */
export async function dispatchAutomationCall(
    tools: readonly Tool[],
    call: AutomationCall,
    signal?: AbortSignal,
): Promise<AutomationResult> {
    const operation = OperationLog.begin("automation.call", {
        tool: call.tool,
        callId: call.id,
        source: "automation-bridge",
        client: call.client ?? "bridge",
    });
    const tool = tools.find((t) => t.name === call.tool);
    if (!tool) {
        operation.finish("error", new Error(`unknown tool ${call.tool}`));
        return { content: JSON.stringify({ error: `this tab has no tool "${call.tool}"` }), isError: true };
    }
    try {
        const answer = await tool.handler(call.args ?? {}, signal);
        const result: AutomationResult =
            typeof answer === "string"
                ? { content: answer, isError: false }
                : { content: answer.content, images: answer.images, isError: false };
        result.isError = reportsError(result.content);
        operation.add({ images: result.images?.length ?? 0, resultChars: result.content.length });
        operation.finish(result.isError ? "error" : "success");
        return result;
    } catch (error) {
        operation.finish("error", error);
        return {
            content: JSON.stringify({ error: `${call.tool} failed: ${describe(error)}` }),
            isError: true,
        };
    }
}

/** What the tab tells the bridge about itself (shown by list_sessions). */
export interface AutomationTabInfo {
    url?: string;
    title?: string;
    documentName?: string;
    documentId?: string;
    appVersion?: string;
}

/** The part of `EventSource` the client uses, so tests can drive it without a server. */
export interface EventSourceLike {
    onerror: ((event: Event) => void) | null;
    addEventListener(type: string, listener: (event: MessageEvent) => void): void;
    close(): void;
}

export interface AutomationClientOptions {
    readonly url?: string;
    /** The tools offered; read again on every (re)registration. */
    readonly tools: () => Tool[];
    readonly info?: () => AutomationTabInfo;
    readonly sessionId?: string;
    readonly eventSource?: (url: string) => EventSourceLike;
    readonly fetch?: typeof fetch;
    /** Reconnect delays: first, cap (ms). */
    readonly backoff?: { readonly first: number; readonly max: number };
}

export type AutomationState = "off" | "connecting" | "connected";

/** A session id that survives reloads of this tab, so a client's `use_session` keeps pointing at it. */
export function tabSessionId(): string {
    const key = "chili3d.automation.session";
    const make = () => `tab-${Math.random().toString(36).slice(2, 10)}`;
    try {
        const existing = globalThis.sessionStorage?.getItem(key);
        if (existing) return existing;
        const id = make();
        globalThis.sessionStorage?.setItem(key, id);
        return id;
    } catch {
        return make();
    }
}

export class AutomationClient extends Observable {
    readonly url: string;
    readonly sessionId: string;
    private source?: EventSourceLike;
    private key?: string;
    private retryTimer?: ReturnType<typeof setTimeout>;
    private delay: number;
    private running = false;
    private readonly calls = new Map<string, AbortController>();
    // Backing fields of the observable properties (see Observable.getPrivateValue).
    private _state: AutomationState = "off";
    private _lastCall: { tool: string; at: number; isError: boolean } | undefined = undefined;
    private _activeCalls = 0;

    constructor(private readonly options: AutomationClientOptions) {
        super();
        this.url = (options.url ?? DEFAULT_AUTOMATION_URL).trim().replace(/\/+$/, "");
        this.sessionId = options.sessionId ?? tabSessionId();
        this.delay = options.backoff?.first ?? 1000;
    }

    get state(): AutomationState {
        return this._state;
    }

    /** The last tool a remote client ran here, and when. */
    get lastCall(): { tool: string; at: number; isError: boolean } | undefined {
        return this._lastCall;
    }

    /** Calls running right now. */
    get activeCalls(): number {
        return this._activeCalls;
    }

    /** Started and not stopped (connected or trying to). */
    get isRunning(): boolean {
        return this.running;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        OperationLog.record("automation.connect", { url: this.url, session: this.sessionId });
        this.connect();
    }

    stop(): void {
        if (!this.running) return;
        this.running = false;
        clearTimeout(this.retryTimer);
        this.source?.close();
        this.source = undefined;
        this.key = undefined;
        for (const controller of this.calls.values()) controller.abort();
        this.calls.clear();
        this.setProperty("state", "off");
        OperationLog.record("automation.disconnect", { url: this.url, session: this.sessionId });
    }

    /** Tells the bridge again what this tab shows (another document became active). */
    async refresh(): Promise<void> {
        if (this.state === "connected") await this.register();
    }

    private connect() {
        if (!this.running) return;
        this.setProperty("state", "connecting");
        const url = `${this.url}/tab/connect?session=${encodeURIComponent(this.sessionId)}`;
        let source: EventSourceLike;
        try {
            source = this.options.eventSource?.(url) ?? new EventSource(url);
        } catch {
            this.scheduleReconnect();
            return;
        }
        this.source = source;
        source.addEventListener("hello", (event) => void this.onHello(event));
        source.addEventListener("call", (event) => void this.onCall(event));
        source.onerror = () => {
            if (this.source !== source) return;
            // EventSource would retry on its own; the client owns the schedule (backoff, stop).
            source.close();
            this.source = undefined;
            this.key = undefined;
            this.scheduleReconnect();
        };
    }

    private scheduleReconnect() {
        if (!this.running) return;
        this.setProperty("state", "connecting");
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.connect(), this.delay);
        this.delay = Math.min(this.delay * 2, this.options.backoff?.max ?? 30_000);
    }

    private async onHello(event: MessageEvent) {
        const hello = parse(event.data) as { key?: string } | undefined;
        if (typeof hello?.key !== "string") return;
        this.key = hello.key;
        if (await this.register()) {
            this.delay = this.options.backoff?.first ?? 1000;
            this.setProperty("state", "connected");
        }
    }

    private async register(): Promise<boolean> {
        const tools = this.options.tools().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
        }));
        return this.post("/tab/register", { info: this.options.info?.() ?? {}, tools });
    }

    private async onCall(event: MessageEvent) {
        const call = parse(event.data) as AutomationCall | undefined;
        if (typeof call?.id !== "string" || typeof call.tool !== "string") return;
        const controller = new AbortController();
        this.calls.set(call.id, controller);
        this.setProperty("activeCalls", this.calls.size);
        const result = await dispatchAutomationCall(this.options.tools(), call, controller.signal);
        this.calls.delete(call.id);
        this.setProperty("activeCalls", this.calls.size);
        this.setProperty("lastCall", { tool: call.tool, at: Date.now(), isError: result.isError });
        await this.post("/tab/result", { id: call.id, result });
    }

    private async post(path: string, body: Record<string, unknown>): Promise<boolean> {
        if (this.key === undefined) return false;
        const fetcher = this.options.fetch ?? globalThis.fetch.bind(globalThis);
        try {
            const response = await fetcher(`${this.url}${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ session: this.sessionId, key: this.key, ...body }),
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}

function parse(data: unknown): unknown {
    try {
        return typeof data === "string" ? JSON.parse(data) : undefined;
    } catch {
        return undefined;
    }
}
