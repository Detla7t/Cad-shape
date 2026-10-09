// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export type OperationOutcome = "success" | "cancelled" | "error" | "rolled_back";
export type LogContext = Record<string, string | number | boolean | undefined>;

/** A named point inside an operation (a pick made, a step completed), with its offset from the start. */
export interface OperationStep {
    name: string;
    atMs: number;
    context?: LogContext;
}

/**
 * One wide event per completed operation. Everything needed to reproduce the situation
 * rides on the event itself: the static session (`session`), the operation's own context
 * (`context`), the state of the application when it finished (`state`, from the registered
 * providers), its causal parent and sequence, and the steps taken on the way.
 */
export interface OperationEvent {
    schema: 2;
    /** Monotonic per session: the order operations finished in. */
    sequence: number;
    operationId: string;
    /** The operation that was still open when this one began (a command for its transactions). */
    parentId?: string;
    operation: string;
    timestamp: string;
    durationMs: number;
    outcome: OperationOutcome;
    session: LogContext;
    context: LogContext;
    state: LogContext;
    steps?: OperationStep[];
    error?: { name: string; message: string; stack?: string };
}

export type OperationContextProvider = () => LogContext | undefined;

export interface OperationHandle {
    readonly operationId: string;
    /** Adds (or overrides) context fields; call as the operation learns more. */
    add(values: LogContext): void;
    /** Records a named step with its time offset: a pick, a stage, a retry. */
    step(name: string, values?: LogContext): void;
    finish(outcome: OperationOutcome, error?: unknown): void;
}

const LIMIT = 2000;
const MAX_STEPS = 60;
const MAX_STACK = 2000;
/** Operations at or above this duration are always retained when the buffer trims. */
const SLOW_MS = 250;

const events: OperationEvent[] = [];
const open: { id: string; operation: string }[] = [];
const providers = new Set<OperationContextProvider>();
let session: LogContext = {
    sessionId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: new Date().toISOString(),
};
let sequence = 0;

function describeError(error: unknown): OperationEvent["error"] {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message.slice(0, 1000),
            ...(error.stack ? { stack: error.stack.slice(0, MAX_STACK) } : {}),
        };
    }
    return { name: "Error", message: String(error).slice(0, 1000) };
}

/** The state providers' view of the application, each one isolated: a throwing provider loses only its own fields. */
function collectState(): LogContext {
    const state: LogContext = {};
    for (const provider of providers) {
        try {
            Object.assign(state, provider());
        } catch (error) {
            state["providerError"] = String(error instanceof Error ? error.message : error).slice(0, 200);
        }
    }
    return state;
}

/**
 * Trims the buffer tail-sampling style: the oldest fast, successful event goes first, so
 * failures, roll-backs and slow operations survive long sessions.
 */
function retain(): void {
    if (events.length <= LIMIT) return;
    const index = events.findIndex(
        (e) => e.outcome === "success" && e.error === undefined && e.durationMs < SLOW_MS,
    );
    events.splice(index < 0 ? 0 : index, 1);
}

function emit(event: OperationEvent): void {
    events.push(event);
    retain();
    if (event.outcome === "error") console.error(event);
    else if (event.outcome === "rolled_back") console.warn(event);
    else console.debug(event);
}

/**
 * Structured, bounded diagnostics: one event per operation, not a diary of what the code
 * did. No per-frame or per-pointer logging; interaction detail belongs on the operation
 * it is part of (`step`), and application state is captured once, at finish, from the
 * registered providers.
 */
export class OperationLog {
    /** Fields every event carries (application version, platform …); merged over the defaults. */
    static setSessionContext(values: LogContext): void {
        session = { ...session, ...values };
    }

    static get sessionContext(): LogContext {
        return { ...session };
    }

    /**
     * Registers a function that describes the application state when an event finishes:
     * the active document and its history head, the selection, the view, preferences.
     * Returns the unregister function.
     */
    static addContextProvider(provider: OperationContextProvider): () => void {
        providers.add(provider);
        return () => providers.delete(provider);
    }

    static begin(operation: string, initial: LogContext = {}): OperationHandle {
        const start = performance.now();
        const operationId = `${Date.now().toString(36)}-${(sequence + open.length + 1).toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 6)}`;
        const parentId = open.at(-1)?.id;
        const context = { ...initial };
        const steps: OperationStep[] = [];
        let finished = false;
        open.push({ id: operationId, operation });
        return {
            operationId,
            add(values: LogContext) {
                Object.assign(context, values);
            },
            step(name: string, values?: LogContext) {
                if (finished || steps.length >= MAX_STEPS) return;
                steps.push({
                    name,
                    atMs: Math.round((performance.now() - start) * 100) / 100,
                    ...(values === undefined ? {} : { context: { ...values } }),
                });
            },
            finish(outcome: OperationOutcome, error?: unknown) {
                if (finished) return;
                finished = true;
                const index = open.findIndex((x) => x.id === operationId);
                if (index >= 0) open.splice(index, 1);
                emit({
                    schema: 2,
                    sequence: ++sequence,
                    operationId,
                    ...(parentId === undefined ? {} : { parentId }),
                    operation,
                    timestamp: new Date().toISOString(),
                    durationMs: Math.round((performance.now() - start) * 100) / 100,
                    outcome,
                    session: { ...session },
                    context: { ...context },
                    state: collectState(),
                    ...(steps.length > 0 ? { steps: [...steps] } : {}),
                    ...(error === undefined ? {} : { error: describeError(error) }),
                });
            },
        };
    }

    /** An instantaneous event (a user-facing error, an unhandled exception): no duration, same enrichment. */
    static record(
        operation: string,
        context: LogContext = {},
        outcome: OperationOutcome = "success",
        error?: unknown,
    ): void {
        emit({
            schema: 2,
            sequence: ++sequence,
            operationId: `${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            ...(open.at(-1) === undefined ? {} : { parentId: open.at(-1)!.id }),
            operation,
            timestamp: new Date().toISOString(),
            durationMs: 0,
            outcome,
            session: { ...session },
            context: { ...context },
            state: collectState(),
            ...(error === undefined ? {} : { error: describeError(error) }),
        });
    }

    /** Operations begun and not yet finished, outermost first. */
    static openOperations(): readonly { id: string; operation: string }[] {
        return open.map((x) => ({ ...x }));
    }

    static snapshot(): OperationEvent[] {
        return structuredClone(events);
    }

    /** NDJSON: a session header line, then one line per event in sequence order. */
    static export(): string {
        const header = {
            schema: 2,
            kind: "session",
            exportedAt: new Date().toISOString(),
            session: { ...session },
            eventCount: events.length,
            openOperations: OperationLog.openOperations(),
        };
        return [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n");
    }

    /** Drops every event and open operation and restarts the sequence (a fresh log, same session). */
    static clear(): void {
        events.length = 0;
        open.length = 0;
        sequence = 0;
    }
}
