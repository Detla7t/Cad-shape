// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { CamGenerator } from "../context/generator";
import { findShapeNode, SetupGeometry, shapesMesh } from "../context/setupGeometry";
import type { SimulationToolpath } from "./motion";
import {
    type SimulationInput,
    type SimulationOptions,
    type SimulationStock,
    type StockSimulation,
    simulateToolpaths,
} from "./simulate";

/**
 * A setup's program as a simulation input: its operations' up-to-date toolpaths (generating
 * what is missing or stale first, unless told not to) with their tools — the same program
 * the post writes, one toolpath per operation that is not suppressed, each carrying its
 * operation's id — the stock in WCS (its box; a bar or a stock body narrows it) and the
 * parts' triangles in WCS.
 */
export async function setupSimulationInput(
    generator: CamGenerator,
    setupId: string,
    options: { readonly regenerate?: boolean } = {},
): Promise<Result<SimulationInput>> {
    const setup = generator.setup(setupId);
    if (setup === undefined) return Result.err("No such setup");
    const machine = generator.machineOf(setup);
    if (machine === undefined) return Result.err(`Unknown machine "${setup.machineId}"`);
    if (machine.kind !== "mill") return Result.err(`Stock simulation is for mills, not a ${machine.kind}`);
    if (options.regenerate ?? true) await generator.ensureSetup(setupId);
    const program = generator.program(setupId);
    if (!program.isOk) return Result.err(program.error);
    const operations = program.value.setup.operations.filter((operation) => !operation.suppressed);
    const toolpaths: SimulationToolpath[] = [];
    for (const [index, toolpath] of program.value.toolpaths.entries()) {
        const tool = program.value.tools.get(toolpath.toolId);
        if (tool === undefined) return Result.err(`The program has no tool "${toolpath.toolId}"`);
        const operation = operations[index];
        toolpaths.push({ toolpath, tool, id: operation?.id, label: operation?.name ?? toolpath.label });
    }
    const geometry = SetupGeometry.build(generator.document, program.value.setup);
    if (!geometry.isOk) return Result.err(geometry.error);
    try {
        const box = geometry.value.stock;
        const stockData = program.value.setup.stock;
        let stock: SimulationStock = { min: box.min, max: box.max };
        if (stockData.kind === "cylinder") {
            stock = {
                ...stock,
                cylinder: {
                    center: [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2],
                    radius: stockData.diameter / 2,
                },
            };
        } else if (stockData.kind === "body") {
            const node = findShapeNode(generator.document, stockData.nodeId);
            const shape = node === undefined ? undefined : geometry.value.shapeInWcs(node);
            if (shape !== undefined) stock = { ...stock, mesh: shapesMesh([shape]) };
        }
        const part = geometry.value.partMesh();
        return Result.ok({ toolpaths, stock, part: part.indices.length > 0 ? part : undefined });
    } finally {
        geometry.value.dispose();
    }
}

/** Simulates a setup's program (see `setupSimulationInput` and `simulateToolpaths`). */
export async function simulateSetup(
    generator: CamGenerator,
    setupId: string,
    options: SimulationOptions & { readonly regenerate?: boolean } = {},
): Promise<Result<StockSimulation>> {
    const input = await setupSimulationInput(generator, setupId, options);
    if (!input.isOk) return Result.err(input.error);
    return simulateToolpaths(input.value, options);
}
