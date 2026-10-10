// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    EVALUATION_COMPUTING,
    EVALUATION_READY,
    type EvaluationState,
    type IDisposable,
    type IDocument,
    type IEvaluationStateSource,
    type INode,
    Logger,
    Result,
    ShapeNode,
    VisualNode,
} from "@chili3d/core";
import type { CamStudioNode } from "../camStudioNode";
import { resolveMachine } from "../machines";
import type { MachineProfileData } from "../model/machine";
import { type CamOperationContext, camOperation } from "../model/operation";
import { type CamProgram, type PostProcessor, postProcessor } from "../model/post";
import type { CamOperationData, SetupData } from "../model/setup";
import type { ToolData } from "../model/tool";
import type { ToolpathData } from "../model/toolpath";
import { createOperationContext, selectionNodeIds } from "./operationContext";
import { SetupGeometry, setupPartNodes } from "./setupGeometry";
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
    /** What changed, when `stale` ("The tool changed", `"Body" was rebuilt or moved`…). */
    readonly staleReason?: string;
}

/**
 * What a result was made from, part by part, so a stale result can say what moved: the
 * operation's data, the setup frame (WCS, stock, parts), the machine, the tool, and the shape
 * token of every node it reads.
 */
interface OperationInputs {
    readonly key: string;
    readonly parts: readonly [operation: string, setup: string, machine: string, tool: string];
    readonly nodes: ReadonlyMap<string, string>;
}

const INPUT_PART_REASONS = [
    "The operation was edited",
    "The setup changed (WCS, stock or parts)",
    "The machine profile changed",
    "The tool changed",
] as const;

interface StoredResult {
    readonly key: string;
    readonly inputs: OperationInputs;
    readonly status: OperationStatus;
}

interface GenerationJob {
    readonly operation: CamOperationData;
    readonly inputs: OperationInputs;
    readonly key: string;
    readonly controller: AbortController;
}

/**
 * Why a setup cannot be posted right now. `postBlockers` lists them; `program` (and so
 * `post`) refuses with the first, so the post action can show exactly what blocks it.
 */
export interface PostBlocker {
    readonly kind: "setup" | "machine" | "part" | "missing" | "running" | "failed" | "stale" | "empty";
    readonly message: string;
    readonly operationId?: string;
    /** The blocker in the shared evaluation vocabulary (what its indicator shows). */
    readonly state: EvaluationState;
}

const NOT_GENERATED = "Not generated yet";
const INPUTS_CHANGED = "Its inputs changed since it was generated";

/**
 * The CAM adapter of the shared evaluation vocabulary: running → computing, an up-to-date
 * toolpath → ready, never generated or inputs changed (also after a failure) → changed with
 * the reason, a failure → failed (CAM never shows a failed operation's previous toolpath as
 * its result). Suppressed operations are not evaluated by design: no state.
 */
export function operationEvaluationState(status: OperationStatus): EvaluationState | undefined {
    switch (status.state) {
        case "suppressed":
            return undefined;
        case "running":
            return EVALUATION_COMPUTING;
        case "pending":
            return { kind: "changed", reason: status.staleReason ?? NOT_GENERATED };
        case "error":
            return status.stale
                ? { kind: "changed", reason: status.staleReason ?? INPUTS_CHANGED }
                : { kind: "failed", message: status.error ?? "", lastGoodShown: false };
        case "ok":
            return status.stale
                ? { kind: "changed", reason: status.staleReason ?? INPUTS_CHANGED }
                : EVALUATION_READY;
    }
}

/** Why one operation blocks posting, or undefined when its toolpath is up to date. */
function operationPostBlocker(operation: CamOperationData, status: OperationStatus): PostBlocker | undefined {
    const state = operationEvaluationState(status);
    if (state === undefined || state.kind === "ready") return undefined;
    const name = `"${operation.name}"`;
    const operationId = operation.id;
    if (state.kind === "computing")
        return { kind: "running", message: `${name} is still generating`, operationId, state };
    if (state.kind === "failed")
        return { kind: "failed", message: `${name} has no toolpath: ${state.message}`, operationId, state };
    if (status.state === "pending" && status.staleReason === undefined)
        return { kind: "missing", message: `${name} has no toolpath`, operationId, state };
    const reason = status.staleReason === undefined ? "" : `: ${status.staleReason}`;
    return { kind: "stale", message: `${name} changed since it was generated${reason}`, operationId, state };
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

function shapeToken(node: INode | undefined): unknown {
    if (!(node instanceof ShapeNode)) return "none";
    const shape = node.shape;
    if (!shape.isOk) return ["error", shape.error];
    let token = shapeTokens.get(shape.value);
    if (token === undefined) {
        token = nextShapeToken++;
        shapeTokens.set(shape.value, token);
    }
    return [
        token,
        node.evaluationError,
        (node as ShapeNode & { rollbackIndex?: number }).rollbackIndex,
        node.worldTransform().toArray(),
        // Include local/ancestor placements too: a visual may update its matrix
        // after our property observer runs, depending on subscription order.
        ancestorPlacements(node),
    ];
}

function ancestorPlacements(node: INode): (readonly number[])[] {
    const placements: (readonly number[])[] = [];
    for (let current: INode | undefined = node; current !== undefined; current = current.parent) {
        if (current instanceof VisualNode) placements.push(current.transform.toArray());
    }
    return placements;
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
    private readonly running = new Map<string, GenerationJob>();
    private readonly listeners = new Set<(operationId?: string) => void>();
    private readonly watched = new Map<string, INode>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;
    readonly document: IDocument;
    private readonly removeDisposeListener: () => void;
    readonly autoRegenerate: boolean;
    private readonly debounceMs: number;

    constructor(
        readonly studio: CamStudioNode,
        options: CamGeneratorOptions = {},
    ) {
        this.autoRegenerate = options.autoRegenerate ?? true;
        this.debounceMs = options.debounceMs ?? 250;
        this.document = studio.document;
        this.removeDisposeListener = studio.onDispose(() => this.dispose());
        studio.onPropertyChanged(this.onStudioChanged);
        this.document.modelManager.addNodeObserver(this.onTreeChanged);
        this.refreshWatches();
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
        if (this.disposed) return { state: "pending" };
        const found = this.find(operationId);
        if (found === undefined) return { state: "pending" };
        if (found.operation.suppressed) return { state: "suppressed" };
        if (this.running.has(operationId))
            return { ...this.results.get(operationId)?.status, state: "running" };
        const stored = this.results.get(operationId);
        if (stored === undefined) return { state: "pending" };
        const inputs = this.inputs(found.setup, found.operation);
        if (inputs.key === stored.key) return stored.status;
        return { ...stored.status, stale: true, staleReason: this.staleReason(stored.inputs, inputs) };
    }

    /** The operation's live evaluation state (`operationEvaluationState` of its status). */
    evaluationSource(operationId: string): IEvaluationStateSource {
        return {
            state: () => operationEvaluationState(this.status(operationId)),
            subscribe: (listener) =>
                this.onChanged((changed) => {
                    if (changed === undefined || changed === operationId) listener();
                }),
        };
    }

    /** The operation's toolpath when it has an up-to-date result. */
    toolpath(operationId: string): ToolpathData | undefined {
        const status = this.status(operationId);
        return status.state === "ok" && !status.stale ? status.toolpath : undefined;
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
        const jobs: GenerationJob[] = operations
            .filter((operation) => !operation.suppressed)
            .map((operation) => {
                const inputs = this.inputs(setup, operation);
                return { operation, inputs, key: inputs.key, controller: new AbortController() };
            });
        for (const job of jobs) {
            this.running.get(job.operation.id)?.controller.abort();
            this.running.set(job.operation.id, job);
        }
        for (const operation of operations) this.emit(operation.id);
        const finish = (job: GenerationJob, status: OperationStatus) => {
            const id = job.operation.id;
            if (this.disposed || this.running.get(id) !== job) return;
            this.running.delete(id);
            const current = this.find(id);
            if (current === undefined || current.operation.suppressed) return;
            if (
                job.controller.signal.aborted ||
                this.inputsKey(current.setup, current.operation) !== job.key
            ) {
                // Keep an existing preview, but never publish newly computed output
                // against inputs it did not use. A first run still needs a retry marker.
                if (!this.results.has(id))
                    this.results.set(id, {
                        key: job.key,
                        inputs: job.inputs,
                        status: { state: "pending", stale: true },
                    });
                this.emit(id);
                this.schedule();
                return;
            }
            this.results.set(id, { key: job.key, inputs: job.inputs, status });
            this.emit(id);
        };
        let geometry: SetupGeometry | undefined;
        try {
            const profile = this.machineOf(setup);
            if (profile === undefined) {
                for (const job of jobs)
                    finish(job, { state: "error", error: `Unknown machine "${setup.machineId}"` });
                return;
            }
            const machine = structuredClone(profile);
            const built = SetupGeometry.build(this.document, setup);
            if (!built.isOk) {
                for (const job of jobs) finish(job, { state: "error", error: built.error });
                return;
            }
            geometry = built.value;
            // Resolve all operations' geometry before the first asynchronous handler.
            // Otherwise later operations or lazy picks could mix two model revisions.
            const contexts = jobs.map((job): Result<CamOperationContext> => {
                try {
                    const context = createOperationContext(
                        built.value,
                        machine,
                        job.operation,
                        undefined,
                        job.controller.signal,
                    );
                    context.selectedFaces();
                    context.selectedEdges();
                    context.selectedLoops();
                    return Result.ok(context);
                } catch (error) {
                    return Result.err(error instanceof Error ? error.message : String(error));
                }
            });
            for (let index = 0; index < jobs.length; index++) {
                const job = jobs[index];
                if (this.disposed) return;
                if (job.controller.signal.aborted) {
                    finish(job, { state: "pending" });
                    continue;
                }
                const context = contexts[index];
                finish(
                    job,
                    context.isOk
                        ? await this.generateOne(context.value, machine, job.operation)
                        : { state: "error", error: context.error },
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            for (const job of jobs) finish(job, { state: "error", error: message });
        } finally {
            geometry?.dispose();
        }
    }

    /** Cancels publication immediately; cooperative handlers also stop their work. */
    cancelOperation(operationId: string): void {
        const job = this.running.get(operationId);
        if (job === undefined) return;
        this.running.delete(operationId);
        job.controller.abort();
        this.emit(operationId);
    }

    private async generateOne(
        context: CamOperationContext,
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

    /**
     * Everything that keeps the setup from posting now, in order: the setup or machine, a part
     * that failed to rebuild, then each operation that is missing, running, failed or stale,
     * or no operations at all. Empty when `program` will succeed. Post generates missing and
     * stale operations first (`ensureSetup`), so those clear by themselves.
     */
    postBlockers(setupId: string): PostBlocker[] {
        const fail = (kind: PostBlocker["kind"], message: string): PostBlocker => ({
            kind,
            message,
            state: { kind: "failed", message, lastGoodShown: false },
        });
        if (this.disposed) return [fail("setup", "The CAM generator is disposed")];
        const setup = this.setup(setupId);
        if (setup === undefined) return [fail("setup", "No such setup")];
        if (this.machineOf(setup) === undefined)
            return [fail("machine", `Unknown machine "${setup.machineId}"`)];
        const blockers: PostBlocker[] = [];
        const parts = setupPartNodes(this.document, setup);
        if (!parts.isOk) blockers.push(fail("part", parts.error));
        const active = setup.operations.filter((operation) => !operation.suppressed);
        for (const operation of active) {
            const blocker = operationPostBlocker(operation, this.status(operation.id));
            if (blocker !== undefined) blockers.push(blocker);
        }
        if (active.length === 0) blockers.push(fail("empty", "The setup has no operations to post"));
        return blockers;
    }

    /** The setup's program from its up-to-date results, in operation order. */
    program(setupId: string): Result<CamProgram> {
        const [blocker] = this.postBlockers(setupId);
        const setup = this.setup(setupId);
        const machine = setup === undefined ? undefined : this.machineOf(setup);
        if (blocker !== undefined || setup === undefined || machine === undefined)
            return Result.err(blocker?.message ?? "No such setup");
        const library = setupTools(setup, machine);
        const tools = new Map<string, ToolData>();
        const toolpaths: ToolpathData[] = [];
        for (const operation of setup.operations) {
            if (operation.suppressed) continue;
            const status = this.status(operation.id);
            // `postBlockers` guarantees an up-to-date toolpath.
            if (status.toolpath === undefined) return Result.err(`"${operation.name}" has no toolpath`);
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
        return this.inputs(setup, operation).key;
    }

    private inputs(setup: SetupData, operation: CamOperationData): OperationInputs {
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
        const tokens = new Map(nodes.map((id) => [id, JSON.stringify(shapeToken(this.findNode(id)))]));
        const tool = machine === undefined ? undefined : operationTool(setup, machine, operation);
        const parts = [
            JSON.stringify(data),
            JSON.stringify(frame),
            JSON.stringify(machine) ?? "",
            JSON.stringify(tool) ?? "",
        ] as const;
        return { key: JSON.stringify([...parts, [...tokens]]), parts, nodes: tokens };
    }

    /** What differs between the inputs a result was made from and the current ones. */
    private staleReason(before: OperationInputs, now: OperationInputs): string {
        const part = before.parts.findIndex((value, index) => value !== now.parts[index]);
        if (part >= 0) return INPUT_PART_REASONS[part];
        for (const [id, token] of now.nodes) {
            if (before.nodes.get(id) === token) continue;
            const node = this.findNode(id);
            if (node === undefined) return `${id} is no longer in the document`;
            if (node instanceof ShapeNode && node.evaluationError !== undefined)
                return `"${node.name}" failed to rebuild`;
            return `"${node.name}" was rebuilt or moved`;
        }
        return INPUTS_CHANGED;
    }

    private findNode(id: string): INode | undefined {
        return this.document.modelManager.findNode((node) => node.id === id);
    }

    private readonly onStudioChanged = (property: string) => {
        if (property !== "setupsJson" && property !== "machinesJson") return;
        this.refreshWatches();
        this.invalidateRunning();
        for (const id of this.results.keys()) {
            if (this.find(id) === undefined) this.results.delete(id);
        }
        this.emit();
        this.schedule();
    };

    private readonly onNodeChanged = (property: string) => {
        if (property !== "shape" && property !== "transform" && property !== "evaluationError") return;
        this.invalidateRunning();
        this.emit();
        this.schedule();
    };

    private readonly onTreeChanged = () => {
        this.refreshWatches();
        this.invalidateRunning();
        this.emit();
        this.schedule();
    };

    private invalidateRunning(): void {
        for (const [id, job] of this.running) {
            const current = this.find(id);
            if (current === undefined || current.operation.suppressed) {
                this.running.delete(id);
                job.controller.abort();
            } else if (this.inputsKey(current.setup, current.operation) !== job.key) {
                job.controller.abort();
            }
        }
    }

    private refreshWatches(): void {
        const ids = new Set(this.studio.setups.flatMap(setupNodeIds));
        const wanted = new Map<string, INode>();
        for (const id of ids) {
            for (let node = this.findNode(id); node !== undefined; node = node.parent) {
                wanted.set(node.id, node);
            }
        }
        for (const [id, node] of [...this.watched]) {
            if (wanted.get(id) !== node) {
                node.removePropertyChanged(this.onNodeChanged);
                this.watched.delete(id);
            }
        }
        for (const [id, node] of wanted) {
            if (this.watched.has(id)) continue;
            node.onPropertyChanged(this.onNodeChanged);
            this.watched.set(id, node);
        }
    }

    private schedule(): void {
        if (!this.autoRegenerate || this.disposed) return;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.regenerateStale().catch((error) => Logger.warn("CAM: regeneration failed", error));
        }, this.debounceMs);
    }

    /** Regenerates every result whose inputs changed (operations never generated stay pending). */
    async regenerateStale(): Promise<void> {
        if (this.disposed) return;
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
        if (this.disposed) return;
        this.disposed = true;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.removeDisposeListener();
        this.document.modelManager.removeNodeObserver(this.onTreeChanged);
        this.studio.removePropertyChanged(this.onStudioChanged);
        for (const node of this.watched.values()) node.removePropertyChanged(this.onNodeChanged);
        this.watched.clear();
        this.listeners.clear();
        this.results.clear();
        for (const job of this.running.values()) job.controller.abort();
        this.running.clear();
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
