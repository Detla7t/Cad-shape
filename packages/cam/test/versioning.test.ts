// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * A CAM Studio in the version store: setups split into per-setup, per-operation and
 * per-tool objects, so an operation edit stores one object, summaries name the operation
 * and its parameter, and edits to different operations (or setups) merge cleanly.
 */

import {
    type DocumentSnapshot,
    diffTrees,
    I18n,
    type Locale,
    MemoryObjectStore,
    mergeTrees,
    type NodeSnapshot,
    Result,
    readTree,
    summarizeDiff,
    writeSnapshot,
} from "@chili3d/core";
import { en } from "@chili3d/i18n";
import {
    type CamOperationData,
    joinSetups,
    type MachineProfileData,
    registerCamOperation,
    type SetupData,
    splitSetups,
} from "../src";

let identity: Locale | undefined;
beforeAll(() => {
    identity = I18n.getLanguages().find((x) => x.language === "en");
    I18n.addLanguage(en);
});
afterAll(() => {
    if (identity !== undefined) I18n.addLanguage(identity);
});

registerCamOperation({
    type: "test.pocket",
    label: "Pocket (test)",
    category: "2d",
    machineKinds: ["mill"],
    defaults: () => ({ depth: 5 }),
    parameters: () => [
        { key: "depth", label: "Depth", kind: "length" },
        { key: "stepover", label: "Stepover", kind: "length" },
    ],
    generate: () => Result.err("not in this test"),
});

const op = (id: string, name: string, params: Record<string, unknown>): CamOperationData => ({
    id,
    type: "test.pocket",
    name,
    toolId: "t1",
    params,
});

const SETUP: SetupData = {
    id: "s1",
    name: "Op 10",
    machineId: "generic-3-axis",
    wcs: { origin: [0, 0, 10], xAxis: [1, 0, 0], zAxis: [0, 0, 1] },
    stock: { kind: "box", margin: { x: 2, y: 2, zTop: 1, zBottom: 0 } },
    partIds: ["body1"],
    operations: [
        op("a", "Pocket 1", { depth: 5, stepover: 2 }),
        op("b", "Pocket 2", { depth: 3, stepover: 2 }),
    ],
    tools: [{ id: "t9", number: 9, name: "Ø3", kind: "flatEndmill", diameter: 3, cutting: { feed: 600 } }],
};

const SETUP2: SetupData = {
    ...SETUP,
    id: "s2",
    name: "Op 20",
    operations: [op("c", "Pocket 3", { depth: 1 })],
    tools: undefined,
};

const MACHINE: MachineProfileData = {
    id: "my-mill",
    name: "My mill",
    kind: "mill",
    linearAxes: [{ name: "X", min: 0, max: 300 }],
    maxFeed: 3000,
    rapidFeed: 5000,
    post: { id: "grbl" },
};

function snapshot(
    setups: readonly SetupData[],
    machines: readonly MachineProfileData[] = [MACHINE],
): DocumentSnapshot {
    const nodes = new Map<string, NodeSnapshot>();
    nodes.set("cam1", {
        cls: "CamStudioNode",
        props: {
            name: "CAM Studio 1",
            setupsJson: JSON.stringify(setups),
            machinesJson: JSON.stringify(machines),
        },
    });
    nodes.set("root", { cls: "FolderNode", props: { name: "Doc", visible: true }, children: ["cam1"] });
    return {
        meta: { name: "Doc", userData: {}, acts: [] },
        rootId: "root",
        nodes,
        variables: [],
        materials: [],
        components: [],
    };
}

function setupsOf(store: MemoryObjectStore, tree: string): SetupData[] {
    return JSON.parse(readTree(store, tree).nodes.get("cam1")!.props["setupsJson"] as string);
}

const withParams = (setup: SetupData, id: string, params: Record<string, unknown>): SetupData => ({
    ...setup,
    operations: setup.operations.map((x) => (x.id === id ? { ...x, params: { ...x.params, ...params } } : x)),
});

test("the splitter round-trips setups with their operations and tools", () => {
    const part = splitSetups(JSON.stringify([SETUP, SETUP2]));
    expect(part?.kind).toBe("rec");
    expect(Object.keys(part?.kind === "rec" ? part.fields : {}).sort()).toEqual([
        "ops/s1",
        "ops/s2",
        "setups",
        "tools/s1",
    ]);
    expect(JSON.parse(joinSetups(part!))).toEqual(
        [SETUP, { ...SETUP2, tools: undefined }].map((x) => JSON.parse(JSON.stringify(x))),
    );
});

test("snapshots round-trip and an operation edit adds O(1) objects", () => {
    const store = new MemoryObjectStore();
    const first = writeSnapshot(store, snapshot([SETUP, SETUP2]));
    expect(setupsOf(store, first)).toEqual(JSON.parse(JSON.stringify([SETUP, SETUP2])));
    const before = store.size;
    writeSnapshot(store, snapshot([withParams(SETUP, "a", { depth: 6 }), SETUP2]));
    // The operation, its setup's operation list, the setups record, the node, its shard, the tree.
    expect(store.size - before).toBe(6);
});

test.each([
    [
        "an operation parameter",
        [withParams(SETUP, "a", { depth: 6 }), SETUP2],
        "CAM Studio 1 › Pocket 1: depth 5 mm → 6 mm",
    ],
    [
        "an added operation",
        [{ ...SETUP, operations: [...SETUP.operations, op("d", "Drill 1", {})] }, SETUP2],
        "CAM Studio 1 › Added Drill 1",
    ],
    [
        "a setup's machine",
        [{ ...SETUP, machineId: "haas-vf2" }, SETUP2],
        "CAM Studio 1 › Op 10: machine generic-3-axis → haas-vf2",
    ],
    [
        "a tool",
        [{ ...SETUP, tools: [{ ...SETUP.tools![0], diameter: 4 }] }, SETUP2],
        "CAM Studio 1 › T9 Ø3: diameter 3 mm → 4 mm",
    ],
] as const)("summarizes %s", (_name, setups, expected) => {
    const store = new MemoryObjectStore();
    const a = writeSnapshot(store, snapshot([SETUP, SETUP2]));
    const b = writeSnapshot(store, snapshot(setups));
    expect(summarizeDiff(diffTrees(store, a, b))).toEqual(expect.arrayContaining([expected]));
});

test("edits to different operations, and an operation added to another setup, merge cleanly", () => {
    const store = new MemoryObjectStore();
    const base = writeSnapshot(store, snapshot([SETUP, SETUP2]));
    const ours = writeSnapshot(store, snapshot([withParams(SETUP, "a", { depth: 6 }), SETUP2]));
    const theirs = writeSnapshot(
        store,
        snapshot([
            withParams(SETUP, "b", { stepover: 1.5 }),
            { ...SETUP2, operations: [...SETUP2.operations, op("e", "Pocket 4", {})] },
        ]),
    );
    const { tree, conflicts } = mergeTrees(store, base, ours, theirs);
    expect(conflicts).toEqual([]);
    const merged = setupsOf(store, tree);
    expect(merged[0].operations.map((x) => x.params)).toEqual([
        { depth: 6, stepover: 2 },
        { depth: 3, stepover: 1.5 },
    ]);
    expect(merged[1].operations.map((x) => x.id)).toEqual(["c", "e"]);
});

test("the same parameter edited on both sides is a conflict", () => {
    const store = new MemoryObjectStore();
    const base = writeSnapshot(store, snapshot([SETUP]));
    const ours = writeSnapshot(store, snapshot([withParams(SETUP, "a", { depth: 6 })]));
    const theirs = writeSnapshot(store, snapshot([withParams(SETUP, "a", { depth: 7 })]));
    expect(mergeTrees(store, base, ours, theirs).conflicts).toHaveLength(1);
});
