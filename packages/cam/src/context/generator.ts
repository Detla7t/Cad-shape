// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDisposable, type INode, Logger, Result } from "@chili3d/core";
import type { CamStudioNode } from "../camStudioNode";
import { resolveMachine } from "../machines";
import type { MachineProfileData } from "../model/machine";
import { camOperation } from "../model/operation";
import { type CamProgram, type PostProcessor, postProcessor } from "../model/post";
import type { CamOperationData, SetupData } from "../model/setup";
import type { ToolData } from "../model/tool";
import type { ToolpathData } from "../model/toolpath";
import { createOperationContext, selectionNodeIds } from "./operationContext";
import { SetupGeometry } from "./setupGeometry";
import { type ToolpathStats, toolpathStats } from "./stats";
import { defaultTool, operationTool, setupTools } from "./tools";

/**
 * Generates a CAM Studio's toolpaths and keeps them: one result per operation, keyed by
 * everything it was made from — the operation's data, its setup (WCS, stock, parts, tools),
 * the machine profile, the tool, and the identity of every part and picked node's current
 * shape. A result whose inputs moved on is `stale`; with `autoRegenerate` the generator
 * regenerates stale results by itself (debounced) when a part is rebuilt or an operation
 * edited, so the preview and the program follow the model. Results are not document data:
 * they are rebuilt from the setups whenever needed.
 */

export type OperationState = "pending" | "running" | "ok" | "error" | "suppressed";

export interface OperationStatus {
    readonly state: OperationState;
    readonly toolpath?: ToolpathData;
    readonly error?: string;
    /** Generation time, ms. */
    readonly ms?: number;
    readonly stats?: ToolpathStats;
    /** The inputs changed since this result was made. */
    readonly stale?: boolean;
}

interface StoredResult {
    readonly key: string;
    readonly status: OperationStatus;
}

export interface CamGeneratorOptions {
    readonly autoRegenerate?: boolean;
    readonly debounceMs?: number;
}

export interface PostedProgram {
    readonly text: string;
    readonly fileName: string;
    readonly post: PostProcessor;
    readonly program: CamProgram;
}

const shapeTokens = new WeakMap<object, number>();
let nextShapeToken = 1;

function shapeToken(node: INode | undefined): string {
    const shape = (node as { shape?: { isOk: boolean; value?: object } } | undefined)?.shape;
    if (shape === undefined) return "none";
    if (!shape.isOk || shape.value === undefined) return "error";
    let token = shapeTokens.get(shape.value);
    if (token === undefined) {
        token = nextShapeToken++;
        shapeTokens.set(shape.value, token);
    }
    return String(token);
}

/** The node ids a setup's results depend on: parts, a stock body, picked nodes. */
export function setupNodeIds(setup: SetupData): string[] {
    const ids = new Set(setup.partIds);
    if (setup.stock.kind === "body") ids.add(setup.stock.nodeId);
    for (const operation of setup.operations)
        for (const id of selectionNodeIds(operation.selection)) ids.add(id);
    return [...ids];
}

export class CamGenerator implements IDisposable {
    private readonly results = new Map<string, StoredResult>();
    private readonly running = new Map<string, number>();
    private readonly listeners = new Set<(operationId?: string) => void>();
    private readonly watched = new Map<string, INode>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;
    private runCounter = 0;
    readonly autoRegenerate: boolean;
    private readonly debounceMs: number;

    constructor(
        readonly studio: CamStudioNode,
        options: CamGeneratorOptions = {},
    ) {
        this.autoRegenerate = options.autoRegenerate ?? true;
        this.debounceMs = options.debounceMs ?? 250;
        studio.onPropertyChanged(this.onStudioChanged);
        this.refreshWatches();
    }

    get document() {
        return this.studio.document;
    }

    // ------------------------------------------------------------------ Lookup

    setup(setupId: string): SetupData | undefined {
        return this.studio.setups.find((setup) => setup.id === setupId);
    }

    machineOf(setup: SetupData): MachineProfileData | undefined {
        return resolveMachine(this.studio, setup.machineId)?.profile;
    }

    /** The operation's current status: its last result (marked `stale` when its inputs changed). */
    status(operationId: string): OperationStatus {
        const found = this.find(operationId);
        if (found === undefined) return { state: "pending" };
        if (found.operation.suppressed) return { state: "suppressed" };
        if (this.running.has(operationId))
            return { ...this.results.get(operationId)?.status, state: "running" };
        const stored = this.results.get(operationId);
        if (stored === undefined) return { state: "pending" };
        const key = this.inputsKey(found.setup, found.operation);
        return key === stored.key ? stored.status : { ...stored.status, stale: true };
    }

    /** The operation's toolpath when it has an up-to-date result. */
    toolpath(operationId: string): ToolpathData | undefined {
        const status = this.status(operationId);
        return status.state === "ok" ? status.toolpath : undefined;
    }

    /** Toolpath of the last result even if stale (what the preview keeps showing while regenerating). */
    lastToolpath(operationId: string): ToolpathData | undefined {
        return this.results.get(operationId)?.status.toolpath;
    }

    onChanged(listener: (operationId?: string) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    // ------------------------------------------------------------------ Generation

    async generateOperation(setupId: string, operationId: string): Promise<OperationStatus> {
        const setup = this.setup(setupId);
        const operation = setup?.operations.find((x) => x.id === operationId);
        if (setup === undefined || operation === undefined)
            return { state: "error", error: "No such operation" };
        await this.run(setup, [operation]);
        return this.status(operationId);
    }

    async generateSetup(setupId: string): Promise<OperationStatus[]> {
        const setup = this.setup(setupId);
        if (setup === undefined) return [];
        await this.run(setup, setup.operations);
        return setup.operations.map((operation) => this.status(operation.id));
    }

    async generateAll(): Promise<void> {
        for (const setup of this.studio.setups) await this.run(setup, setup.operations);
    }

    /** Generates whatever in the setup is missing or stale (what Post needs). */
    async ensureSetup(setupId: string): Promise<void> {
        const setup = this.setup(setupId);
        if (setup === undefined) return;
        const needed = setup.operations.filter((operation) => {
            const status = this.status(operation.id);
            return status.state !== "suppressed" && (status.state !== "ok" || status.stale);
        });
        if (needed.length > 0) await this.run(setup, needed);
    }

    private async run(setup: SetupData, operations: readonly CamOperationData[]): Promise<void> {
        if (this.disposed || operations.length === 0) return;
        const runId = ++this.runCounter;
        const live = operations.filter((operation) => !operation.suppressed);
        for (const operation of live) this.running.set(operation.id, runId);
        for (const operation of operations) this.emit(operation.id);
        const machine = this.machineOf(setup);
        const finish = (operation: CamOperationData, status: OperationStatus) => {
            if (this.running.get(operation.id) !== runId) return;
            this.running.delete(operation.id);
            this.results.set(operation.id, { key: this.inputsKey(setup, operation), status });
            this.emit(operation.id);
        };
        if (machine === undefined) {
            for (const operation of live)
                finish(operation, { state: "error", error: `Unknown machine "${setup.machineId}"` });
            return;
        }
        const geometry = SetupGeometry.build(this.document, setup);
        if (!geometry.isOk) {
            for (const operation of live) finish(operation, { state: "error", error: geometry.error });
            return;
        }
        try {
            for (const operation of live) {
                if (this.disposed) return;
                finish(operation, await this.generateOne(geometry.value, machine, operation));
            }
        } finally {
            geometry.value.dispose();
        }
    }

    private async generateOne(
        geometry: SetupGeometry,
        machine: MachineProfileData,
        operation: CamOperationData,
    ): Promise<OperationStatus> {
        const handler = camOperation(operation.type);
        if (handler === undefined)
            return { state: "error", error: `No operation type "${operation.type}" is available` };
        if (!handler.machineKinds.includes(machine.kind)) {
            return {
                state: "error",
                error: `${handler.label} does not run on a ${machine.kind} (${machine.name})`,
            };
        }
        const started = now();
        try {
            const context = createOperationContext(geometry, machine, operation);
            const result = await handler.generate(operation, context);
            const ms = now() - started;
            if (!result.isOk) return { state: "error", error: result.error, ms };
            return { state: "ok", toolpath: result.value, ms, stats: toolpathStats(result.value, machine) };
        } catch (error) {
            Logger.warn(`CAM: "${operation.name}" failed`, error);
            return {
                state: "error",
                error: error instanceof Error ? error.message : String(error),
                ms: now() - started,
            };
        }
    }

    // ------------------------------------------------------------------ Programs

    /** The setup's program from its up-to-date results, in operation order. */
    program(setupId: string): Result<CamProgram> {
        const setup = this.setup(setupId);
        if (setup === undefined) return Result.err("No such setup");
        const machine = this.machineOf(setup);
        if (machine === undefined) return Result.err(`Unknown machine "${setup.machineId}"`);
        const library = setupTools(setup, machine);
        const tools = new Map<string, ToolData>();
        const toolpaths: ToolpathData[] = [];
        for (const operation of setup.operations) {
            if (operation.suppressed) continue;
            const status = this.status(operation.id);
            if (status.state !== "ok" || status.toolpath === undefined) {
                return Result.err(
                    `"${operation.name}" has no toolpath${status.error ? `: ${status.error}` : ""}`,
                );
            }
            if (status.stale) return Result.err(`"${operation.name}" changed since it was generated`);
            const tool =
                library.find((x) => x.id === status.toolpath!.toolId) ??
                (status.toolpath.toolId === "default"
                    ? defaultTool(machine)
                    : operationTool(setup, machine, operation));
            tools.set(
                status.toolpath.toolId,
                tool.id === status.toolpath.toolId ? tool : { ...tool, id: status.toolpath.toolId },
            );
            toolpaths.push({ ...status.toolpath, label: operation.name });
        }
        if (toolpaths.length === 0) return Result.err("The setup has no operations to post");
        return Result.ok({ name: setup.programName ?? setup.name, machine, setup, tools, toolpaths });
    }

    /** Posts the setup's program with its post (or `postId`) and options. */
    post(
        setupId: string,
        postId?: string,
        options?: Readonly<Record<string, unknown>>,
    ): Result<PostedProgram> {
        const setup = this.setup(setupId);
        if (setup === undefined) return Result.err("No such setup");
        const program = this.program(setupId);
        if (!program.isOk) return Result.err(program.error);
        const id = postId ?? setup.postId ?? program.value.machine.post.id;
        const post = postProcessor(id);
        if (post === undefined) return Result.err(`No post-processor "${id}" is available`);
        if (!post.machineKinds.includes(program.value.machine.kind)) {
            return Result.err(`${post.name} does not write programs for a ${program.value.machine.kind}`);
        }
        const text = post.post(program.value, { ...setup.postOptions, ...options });
        if (!text.isOk) return Result.err(text.error);
        const base = program.value.name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "program";
        return Result.ok({
            text: text.value,
            fileName: `${base}${post.extension}`,
            post,
            program: program.value,
        });
    }

    // ------------------------------------------------------------------ Change tracking

    private find(operationId: string): { setup: SetupData; operation: CamOperationData } | undefined {
        for (const setup of this.studio.setups) {
            const operation = setup.operations.find((x) => x.id === operationId);
            if (operation !== undefined) return { setup, operation };
        }
        return undefined;
    }

    private inputsKey(setup: SetupData, operation: CamOperationData): string {
        const machine = this.machineOf(setup);
        const {
            operations: _operations,
            name: _setupName,
            programName: _program,
            postId: _post,
            postOptions: _options,
            ...frame
        } = setup;
        const { name: _name, ...data } = operation;
        const nodes = [...setup.partIds, ...selectionNodeIds(operation.selection)];
        if (setup.stock.kind === "body") nodes.push(setup.stock.nodeId);
        const tokens = nodes.map((id) => `${id}:${shapeToken(this.findNode(id))}`);
        const tool = machine === undefined ? undefined : operationTool(setup, machine, operation);
        return JSON.stringify([data, frame, machine, tool, tokens]);
    }

    private findNode(id: string): INode | undefined {
        const watched = this.watched.get(id);
        if (watched !== undefined) return watched;
        return this.document.modelManager.findNodes((node) => node.id === id)[0];
    }

    private readonly onStudioChanged = (property: string) => {
        if (property !== "setupsJson" && property !== "machinesJson") return;
        this.refreshWatches();
        this.emit();
        this.schedule();
    };

    private readonly onNodeChanged = (property: string) => {
        if (property !== "shape") return;
        this.emit();
        this.schedule();
    };

    private refreshWatches(): void {
        const ids = new Set(this.studio.setups.flatMap(setupNodeIds));
        for (const [id, node] of [...this.watched]) {
            if (!ids.has(id)) {
                node.removePropertyChanged(this.onNodeChanged);
                this.watched.delete(id);
            }
        }
        for (const id of ids) {
            if (this.watched.has(id)) continue;
            const [node] = this.document.modelManager.findNodes((candidate) => candidate.id === id);
            if (node === undefined) continue;
            node.onPropertyChanged(this.onNodeChanged);
            this.watched.set(id, node);
        }
    }

    private schedule(): void {
        if (!this.autoRegenerate || this.disposed) return;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.regenerateStale();
        }, this.debounceMs);
    }

    /** Regenerates every result whose inputs changed (operations never generated stay pending). */
    async regenerateStale(): Promise<void> {
        for (const setup of this.studio.setups) {
            const stale = setup.operations.filter((operation) => {
                if (!this.results.has(operation.id) || this.running.has(operation.id)) return false;
                const status = this.status(operation.id);
                return status.stale === true;
            });
            if (stale.length > 0) await this.run(setup, stale);
        }
    }

    private emit(operationId?: string): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(operationId);
            } catch (error) {
                Logger.warn("CAM: a generator listener failed", error);
            }
        }
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.studio.removePropertyChanged(this.onStudioChanged);
        for (const node of this.watched.values()) node.removePropertyChanged(this.onNodeChanged);
        this.watched.clear();
        this.listeners.clear();
        this.results.clear();
    }
}

function now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** The generator of each studio, shared by its view and the preview. */
const generators = new WeakMap<CamStudioNode, CamGenerator>();

export function generatorOf(studio: CamStudioNode): CamGenerator {
    let generator = generators.get(studio);
    if (generator === undefined) {
        generator = new CamGenerator(studio);
        generators.set(studio, generator);
    }
    return generator;
}
