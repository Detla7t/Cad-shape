// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export type OperationOutcome = "success" | "cancelled" | "error" | "rolled_back";
export type LogContext = Record<string, string | number | boolean | undefined>;
export interface OperationEvent {
    schema: 1;
    operationId: string;
    operation: string;
    timestamp: string;
    durationMs: number;
    outcome: OperationOutcome;
    context: LogContext;
    error?: { name: string; message: string };
}
const events: OperationEvent[] = [];
const LIMIT = 500;
let sequence = 0;

/** One bounded, structured completion event per operation; no per-frame/pointer logging. */
export class OperationLog {
    static begin(operation: string, initial: LogContext = {}) {
        const start = performance.now();
        const operationId = `${Date.now().toString(36)}-${(++sequence).toString(36)}`;
        const context = { ...initial };
        let finished = false;
        return {
            operationId,
            add(values: LogContext) {
                Object.assign(context, values);
            },
            finish(outcome: OperationOutcome, error?: unknown) {
                if (finished) return;
                finished = true;
                const event: OperationEvent = {
                    schema: 1,
                    operationId,
                    operation,
                    timestamp: new Date().toISOString(),
                    durationMs: Math.round((performance.now() - start) * 100) / 100,
                    outcome,
                    context: { ...context },
                    ...(error === undefined
                        ? {}
                        : {
                              error: {
                                  name: error instanceof Error ? error.name : "Error",
                                  message: String(error instanceof Error ? error.message : error).slice(
                                      0,
                                      1000,
                                  ),
                              },
                          }),
                };
                events.push(event);
                if (events.length > LIMIT) events.shift();
                if (outcome === "error") console.error(event);
                else if (outcome === "rolled_back") console.warn(event);
                else console.info(event);
            },
        };
    }
    static snapshot(): OperationEvent[] {
        return structuredClone(events);
    }
    static export(): string {
        return events.map((e) => JSON.stringify(e)).join("\n");
    }
    static clear(): void {
        events.length = 0;
    }
}
