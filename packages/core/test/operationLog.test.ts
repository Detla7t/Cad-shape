// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { OperationLog } from "../src";

beforeEach(() => {
    rs.spyOn(console, "error").mockImplementation(() => {});
    rs.spyOn(console, "warn").mockImplementation(() => {});
    rs.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
    OperationLog.clear();
    rs.restoreAllMocks();
});

test("a completed operation is one wide event: context, session, state, steps, duration and error", () => {
    OperationLog.setSessionContext({ appVersion: "1.2.3" });
    const unregister = OperationLog.addContextProvider(() => ({ documentId: "d", selectedNodes: 2 }));
    try {
        const operation = OperationLog.begin("sketch.solve", { sketchId: "s", entities: 4 });
        operation.step("pick.point", { entityId: 7, pointIndex: 1 });
        operation.add({ constraints: 8, dofs: 2 });
        operation.finish("error", new Error("Conflicting constraints"));
        operation.finish("success");
        const events = OperationLog.snapshot();
        expect(events).toHaveLength(1);
        const [event] = events;
        expect(event).toMatchObject({
            schema: 2,
            sequence: 1,
            operation: "sketch.solve",
            outcome: "error",
            context: { sketchId: "s", entities: 4, constraints: 8, dofs: 2 },
            state: { documentId: "d", selectedNodes: 2 },
            session: { appVersion: "1.2.3" },
        });
        expect(typeof event.session["sessionId"]).toBe("string");
        expect(event.steps).toEqual([
            { name: "pick.point", atMs: expect.any(Number), context: { entityId: 7, pointIndex: 1 } },
        ]);
        expect(event.error).toMatchObject({ name: "Error", message: "Conflicting constraints" });
        expect(event.error?.stack).toContain("Conflicting constraints");
        expect(event.durationMs).toBeGreaterThanOrEqual(0);
        expect(event.parentId).toBeUndefined();
    } finally {
        unregister();
    }
});

test("nested operations record their parent, and a throwing provider loses only its own fields", () => {
    const unregister = OperationLog.addContextProvider(() => {
        throw new Error("no state today");
    });
    const other = OperationLog.addContextProvider(() => ({ fine: true }));
    try {
        const command = OperationLog.begin("command.execute", { command: "feature.extrude" });
        const transaction = OperationLog.begin("model.transaction", { action: "extrude" });
        const rebuild = OperationLog.begin("feature.rebuild");
        rebuild.finish("success");
        transaction.finish("success");
        OperationLog.record("ui.error", { message: "Depth must be nonzero." }, "error");
        expect(OperationLog.openOperations().map((x) => x.operation)).toEqual(["command.execute"]);
        command.finish("success");
        const [rebuildEvent, transactionEvent, uiError, commandEvent] = OperationLog.snapshot();
        expect(rebuildEvent.parentId).toBe(transaction.operationId);
        expect(transactionEvent.parentId).toBe(command.operationId);
        expect(uiError.parentId).toBe(command.operationId);
        expect(uiError).toMatchObject({
            outcome: "error",
            durationMs: 0,
            context: { message: "Depth must be nonzero." },
        });
        expect(commandEvent.parentId).toBeUndefined();
        expect(commandEvent.sequence).toBe(4);
        expect(commandEvent.state).toEqual({ fine: true, providerError: "no state today" });
        expect(OperationLog.openOperations()).toEqual([]);
    } finally {
        unregister();
        other();
    }
});

test("the export is NDJSON with a session header, and snapshots cannot mutate the log", () => {
    OperationLog.begin("edit", { index: 1 }).finish("success");
    const lines = OperationLog.export().split("\n");
    expect(lines).toHaveLength(2);
    const header = JSON.parse(lines[0]);
    expect(header).toMatchObject({ schema: 2, kind: "session", eventCount: 1, openOperations: [] });
    expect(typeof header.session.sessionId).toBe("string");
    expect(JSON.parse(lines[1]).context).toEqual({ index: 1 });
    const events = OperationLog.snapshot();
    events[0].context["index"] = -1;
    expect(OperationLog.snapshot()[0].context["index"]).toBe(1);
});

test("retention trims fast successes first, keeping failures and slow operations", () => {
    OperationLog.begin("boot", { kept: "error" }).finish("error", new Error("x"));
    OperationLog.begin("boot", { kept: "rolledBack" }).finish("rolled_back");
    for (let i = 0; i < 2005; i++) OperationLog.begin("edit", { index: i }).finish("success");
    const events = OperationLog.snapshot();
    expect(events).toHaveLength(2000);
    expect(events.slice(0, 2).map((e) => e.context["kept"])).toEqual(["error", "rolledBack"]);
    // the seven oldest successes were dropped, nothing else
    expect(events[2].context["index"]).toBe(7);
    expect(events.at(-1)?.context["index"]).toBe(2004);
});
