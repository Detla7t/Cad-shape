// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Id, type INode, ShapeNode, Transaction } from "@chili3d/core";
import { SketchNode } from "@chili3d/parametric";
import type { CamStudioNode } from "../camStudioNode";
import { operationTool, setupTools } from "../context/tools";
import { WORLD_WCS } from "../context/wcs";
import type { MachineProfileData } from "../model/machine";
import { type CamOperationHandler, camOperation } from "../model/operation";
import type { CamOperationData, SetupData, StockData } from "../model/setup";
import type { ToolData } from "../model/tool";

/**
 * Every edit the CAM Studio makes, as a pure function of the setups plus one recorded
 * write: `commitSetups` replaces `setupsJson` inside a transaction, so each edit is one
 * undo step (and one microversion). The view never mutates a setup in place.
 */

export function commitSetups(studio: CamStudioNode, name: string, setups: readonly SetupData[]): void {
    Transaction.execute(studio.document, `cam: ${name}`, () => studio.setSetups(setups));
}

export function commitMachines(
    studio: CamStudioNode,
    name: string,
    machines: readonly MachineProfileData[],
): void {
    Transaction.execute(studio.document, `cam: ${name}`, () => studio.setMachines(machines));
}

/** The default stock of a machine kind: a box around the parts, or a sheet for 2D cutting. */
export function defaultStock(machine: MachineProfileData | undefined): StockData {
    if (machine !== undefined && machine.kind !== "mill" && machine.kind !== "printer") {
        return { kind: "sheet", width: 1000, height: 500, thickness: 6 };
    }
    return { kind: "box", margin: { x: 2, y: 2, zTop: 1, zBottom: 0 } };
}

/** `<base> 1`, `<base> 2`, … — the first name none of `names` uses. */
export function nextName(names: readonly string[], base: string): string {
    const taken = new Set(names);
    for (let n = 1; ; n++) {
        const name = `${base} ${n}`;
        if (!taken.has(name)) return name;
    }
}

/** The document's bodies a setup can machine: shape nodes that are not sketches. */
export function documentBodies(nodes: readonly INode[]): ShapeNode[] {
    return nodes.filter(
        (node): node is ShapeNode => node instanceof ShapeNode && !(node instanceof SketchNode),
    );
}

export function newSetup(
    setups: readonly SetupData[],
    machine: MachineProfileData | undefined,
    partIds: readonly string[],
): SetupData {
    return {
        id: Id.generate(),
        name: nextName(
            setups.map((setup) => setup.name),
            "Setup",
        ),
        machineId: machine?.id ?? "generic-3-axis",
        wcs: WORLD_WCS,
        stock: defaultStock(machine),
        partIds: [...partIds],
        operations: [],
    };
}

export function replaceSetup(setups: readonly SetupData[], setup: SetupData): SetupData[] {
    return setups.map((x) => (x.id === setup.id ? setup : x));
}

export function removeSetup(setups: readonly SetupData[], setupId: string): SetupData[] {
    return setups.filter((x) => x.id !== setupId);
}

export function moveItem<T extends { readonly id: string }>(
    items: readonly T[],
    id: string,
    offset: -1 | 1,
): T[] {
    const index = items.findIndex((x) => x.id === id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= items.length) return [...items];
    const copy = [...items];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    return copy;
}

/** A copy of a setup with fresh ids (its operations too). */
export function duplicateSetup(setups: readonly SetupData[], setup: SetupData): SetupData {
    return {
        ...setup,
        id: Id.generate(),
        name: nextName(
            setups.map((x) => x.name),
            `${setup.name} copy`,
        ),
        operations: setup.operations.map((operation) => ({ ...operation, id: Id.generate() })),
    };
}

export function newOperation(
    setup: SetupData,
    machine: MachineProfileData,
    handler: CamOperationHandler,
): CamOperationData {
    const tools = setupTools(setup, machine);
    const tool = suitableTool(handler, tools);
    return {
        id: Id.generate(),
        type: handler.type,
        name: nextName(
            setup.operations.map((operation) => operation.name),
            handler.label,
        ),
        ...(tool === undefined ? {} : { toolId: tool.id }),
        params: handler.defaults(machine, tool),
    };
}

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The setup's operations moved to machine `to` (from `from`): a tool the new library lacks
 * is replaced by the handler's first guess, and every parameter still at the value the
 * handler derived from the old machine and tool (kerf, pierce settings, heights, feeds and
 * speeds) takes the new machine's — values the user set are kept. Without this an operation
 * moved from a plasma table to a waterjet kept the torch's kerf and feed.
 */
export function rebaseOperations(
    setup: SetupData,
    from: MachineProfileData | undefined,
    to: MachineProfileData,
): CamOperationData[] {
    const tools = setupTools(setup, to);
    return setup.operations.map((operation) => {
        const handler = camOperation(operation.type);
        // An operation the new machine cannot run is left alone (it reports so when generated).
        if (handler === undefined || !handler.machineKinds.includes(to.kind)) return operation;
        const tool = tools.find((x) => x.id === operation.toolId) ?? suitableTool(handler, tools);
        const before =
            from === undefined || !handler.machineKinds.includes(from.kind)
                ? {}
                : handler.defaults(from, operationTool(setup, from, operation));
        const after = handler.defaults(to, tool);
        const params: Record<string, unknown> = { ...operation.params };
        for (const [key, value] of Object.entries(after)) {
            if (key in before && sameValue(params[key], before[key])) params[key] = value;
        }
        const { toolId: _old, ...rest } = operation;
        return { ...rest, ...(tool === undefined ? {} : { toolId: tool.id }), params };
    });
}

/**
 * A first tool guess per operation category: drills for hole cycles, end mills for roughing
 * (a ball's finishing stepover would clear the stock in hair-thin rings), balls for 3D finishing.
 */
function suitableTool(handler: CamOperationHandler, tools: readonly ToolData[]): ToolData | undefined {
    const wanted = /drill|bore|tap|spot/i.test(handler.type)
        ? ["drill", "spotDrill", "tap"]
        : /rough/i.test(handler.type)
          ? ["flatEndmill", "bullNose", "ballEndmill"]
          : handler.category === "3d" || handler.category === "5axis"
            ? ["ballEndmill", "bullNose", "flatEndmill"]
            : /engrav|chamfer|deburr/i.test(handler.type)
              ? ["chamfer", "vBit", "engraver"]
              : ["flatEndmill", "bullNose", "jet", "wire", "nozzle"];
    for (const kind of wanted) {
        const tool = tools.find((x) => x.kind === kind);
        if (tool !== undefined) return tool;
    }
    return tools[0];
}

export function updateOperation(
    setup: SetupData,
    operationId: string,
    change: (operation: CamOperationData) => CamOperationData,
): SetupData {
    return { ...setup, operations: setup.operations.map((x) => (x.id === operationId ? change(x) : x)) };
}

export function setOperationParam(
    operation: CamOperationData,
    key: string,
    value: unknown,
): CamOperationData {
    return { ...operation, params: { ...operation.params, [key]: value } };
}

export function removeOperation(setup: SetupData, operationId: string): SetupData {
    return { ...setup, operations: setup.operations.filter((x) => x.id !== operationId) };
}

export function duplicateOperation(setup: SetupData, operation: CamOperationData): SetupData {
    const copy: CamOperationData = {
        ...operation,
        id: Id.generate(),
        name: nextName(
            setup.operations.map((x) => x.name),
            `${operation.name} copy`,
        ),
    };
    const index = setup.operations.findIndex((x) => x.id === operation.id);
    const operations = [...setup.operations];
    operations.splice(index + 1, 0, copy);
    return { ...setup, operations };
}

/** Writes a tool into the setup's own tools (adding, replacing, or overriding a machine tool by id). */
export function putSetupTool(setup: SetupData, tool: ToolData): SetupData {
    const tools = setup.tools ?? [];
    const exists = tools.some((x) => x.id === tool.id);
    return { ...setup, tools: exists ? tools.map((x) => (x.id === tool.id ? tool : x)) : [...tools, tool] };
}

/** Removes a setup tool; operations that used it fall back to the first tool. */
export function removeSetupTool(setup: SetupData, toolId: string): SetupData {
    const tools = (setup.tools ?? []).filter((x) => x.id !== toolId);
    return { ...setup, tools };
}

/** The handler of an operation, if its module is loaded. */
export function handlerOf(operation: CamOperationData): CamOperationHandler | undefined {
    return camOperation(operation.type);
}
