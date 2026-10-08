// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { OperationLog } from "../src";

afterEach(() => {
    OperationLog.clear();
    rs.restoreAllMocks();
});
test("a completed operation has one context-rich event, including failure and duration", () => {
    rs.spyOn(console, "error").mockImplementation(() => {});
    const operation = OperationLog.begin("sketch.solve", { documentId: "d", sketchId: "s", entities: 4 });
    operation.add({ constraints: 8, dofs: 2 });
    operation.finish("error", new Error("Conflicting constraints"));
    operation.finish("success");
    const events = OperationLog.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0].context).toEqual({
        documentId: "d",
        sketchId: "s",
        entities: 4,
        constraints: 8,
        dofs: 2,
    });
    expect(events[0].outcome).toBe("error");
    expect(events[0].error?.message).toBe("Conflicting constraints");
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(OperationLog.export()).operationId).toBe(operation.operationId);
});
test("retention is bounded and snapshots cannot mutate the log", () => {
    rs.spyOn(console, "info").mockImplementation(() => {});
    for (let i = 0; i < 505; i++) OperationLog.begin("edit", { index: i }).finish("success");
    const events = OperationLog.snapshot();
    expect(events).toHaveLength(500);
    expect(events[0].context["index"]).toBe(5);
    events[0].context["index"] = -1;
    expect(OperationLog.snapshot()[0].context["index"]).toBe(5);
});
