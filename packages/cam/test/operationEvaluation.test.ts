// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type OperationStatus, operationEvaluationState } from "../src";

describe("operationEvaluationState (the CAM adapter of the shared evaluation vocabulary)", () => {
    test.each<[string, OperationStatus, unknown]>([
        ["suppressed: not evaluated", { state: "suppressed" }, undefined],
        ["running: computing", { state: "running" }, { kind: "computing" }],
        ["never generated: changed", { state: "pending" }, { kind: "changed", reason: "Not generated yet" }],
        ["up to date: ready", { state: "ok" }, { kind: "ready" }],
        [
            "stale toolpath: changed with the reason",
            { state: "ok", stale: true, staleReason: "The tool changed" },
            { kind: "changed", reason: "The tool changed" },
        ],
        [
            "failure: failed, no last good toolpath stands in",
            { state: "error", error: "No pocket boundary" },
            { kind: "failed", message: "No pocket boundary", lastGoodShown: false },
        ],
        [
            "failure whose inputs moved on: changed (it regenerates)",
            {
                state: "error",
                error: "No pocket boundary",
                stale: true,
                staleReason: '"Body" was rebuilt or moved',
            },
            { kind: "changed", reason: '"Body" was rebuilt or moved' },
        ],
    ])("%s", (_name, status, expected) => {
        expect(operationEvaluationState(status)).toEqual(expected);
    });
});
