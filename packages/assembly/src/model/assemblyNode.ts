// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type I18nKeys,
    type IDisposable,
    type IDocument,
    Id,
    type INode,
    type INodeIcon,
    type INodeSceneless,
    type INodeWarning,
    Logger,
    Node,
    Signal,
    serializable,
    serialize,
    Transaction,
} from "@chili3d/core";
import { type ILinkConsumer, type LinkSlot, linkService } from "../link/linkRegistry";
import type { LinkState, PartLinkData } from "../link/linkTypes";
import type { AssemblyInstanceData, MateData } from "./assemblyTypes";

export interface AssemblyNodeOptions {
    document: IDocument;
    name?: string;
    id?: string;
    instancesJson?: string;
    matesJson?: string;
    instances?: readonly AssemblyInstanceData[];
    mates?: readonly MateData[];
}

/**
 * An Assembly — a document element (a bottom tab, like Onshape's) that places INSTANCES of
 * parts and sub-assemblies and joins them with MATES. Like a parametric body it holds data
 * only: instances name their source (a part of this document's Part Studio, another
 * assembly of this document, or a part or assembly linked from another document at a
 * version) and carry a placement; the geometry is looked up live (`evaluate.ts`), so a part
 * edit or a linked part's new version flows into the assembly.
 *
 * `instancesJson` and `matesJson` are recorded properties: every edit — inserting, moving,
 * grounding, mating, solving, updating a link — is one undo step and one microversion.
 *
 * It is also the link consumer for its linked instances (one slot per instance).
 */
@serializable()
export class AssemblyNode extends Node implements INodeIcon, INodeSceneless, INodeWarning, ILinkConsumer {
    /**
     * Runs inside the transaction that moves a linked instance to a new version, so mates follow
     * the new geometry in the same undo step (installed by `solve.ts`: re-anchor and re-solve).
     */
    static linkFollowUp: ((assembly: AssemblyNode) => void) | undefined;

    readonly sceneless = true as const;
    /** Fires when instance geometry may have changed without a recorded edit (a link resolved). */
    readonly geometryChanged = new Signal<() => void>();
    private readonly _states = new Map<string, LinkState>();
    private readonly _registration: IDisposable | undefined;
    private _instancesCache: { json: string; value: AssemblyInstanceData[] } | undefined;
    private _matesCache: { json: string; value: MateData[] } | undefined;

    get icon(): string {
        return "icon-layer-group";
    }

    constructor(options: AssemblyNodeOptions) {
        super(options.document, options.name ?? "Assembly", options.id ?? Id.generate());
        this.setPrivateValue(
            "instancesJson",
            options.instancesJson ?? JSON.stringify(options.instances ?? []),
        );
        this.setPrivateValue("matesJson", options.matesJson ?? JSON.stringify(options.mates ?? []));
        this._registration = linkService()?.register(this);
    }

    @serialize()
    get instancesJson(): string {
        return this.getPrivateValue("instancesJson");
    }
    set instancesJson(value: string) {
        this.setProperty("instancesJson", value);
    }

    @serialize()
    get matesJson(): string {
        return this.getPrivateValue("matesJson");
    }
    set matesJson(value: string) {
        this.setProperty("matesJson", value);
    }

    get instances(): readonly AssemblyInstanceData[] {
        const json = this.instancesJson;
        if (this._instancesCache?.json !== json)
            this._instancesCache = { json, value: parseList(json, this.name) };
        return this._instancesCache.value;
    }

    get mates(): readonly MateData[] {
        const json = this.matesJson;
        if (this._matesCache?.json !== json) this._matesCache = { json, value: parseList(json, this.name) };
        return this._matesCache.value;
    }

    instance(id: string): AssemblyInstanceData | undefined {
        return this.instances.find((x) => x.id === id);
    }

    // ------------------------------------------------------------------ Editing (each one undo step)

    setInstances(instances: readonly AssemblyInstanceData[], name = "edit instances"): void {
        const json = JSON.stringify(instances);
        if (json === this.instancesJson) return;
        Transaction.execute(this.document, name, () => {
            this.instancesJson = json;
        });
    }

    setMates(mates: readonly MateData[], name = "edit mates"): void {
        const json = JSON.stringify(mates);
        if (json === this.matesJson) return;
        Transaction.execute(this.document, name, () => {
            this.matesJson = json;
        });
    }

    /** Instances and mates together, as one step (deleting an instance drops its mates). */
    setContent(instances: readonly AssemblyInstanceData[], mates: readonly MateData[], name: string): void {
        Transaction.execute(this.document, name, () => {
            this.setInstances(instances, name);
            this.setMates(mates, name);
        });
    }

    addInstances(instances: readonly AssemblyInstanceData[]): void {
        this.setInstances([...this.instances, ...instances], "insert instance");
    }

    updateInstance(
        id: string,
        patch: Partial<Omit<AssemblyInstanceData, "id">>,
        name = "edit instance",
    ): void {
        this.setInstances(
            this.instances.map((x) => (x.id === id ? { ...x, ...patch } : x)),
            name,
        );
    }

    removeInstances(ids: readonly string[]): void {
        const gone = new Set(ids);
        this.setContent(
            this.instances.filter((x) => !gone.has(x.id)),
            this.mates.filter((m) => !gone.has(m.a.instanceId) && !gone.has(m.b.instanceId)),
            "delete instance",
        );
    }

    addMate(mate: MateData): void {
        this.setMates([...this.mates, mate], "add mate");
    }

    updateMate(id: string, patch: Partial<Omit<MateData, "id">>): void {
        this.setMates(
            this.mates.map((x) => (x.id === id ? { ...x, ...patch } : x)),
            "edit mate",
        );
    }

    removeMates(ids: readonly string[]): void {
        const gone = new Set(ids);
        this.setMates(
            this.mates.filter((m) => !gone.has(m.id)),
            "delete mate",
        );
    }

    /** Writes solved placements (one step; nothing when no instance moved). */
    setTransforms(transforms: ReadonlyMap<string, readonly number[]>, name = "solve mates"): void {
        let changed = false;
        const next = this.instances.map((x) => {
            const transform = transforms.get(x.id);
            if (transform === undefined || sameTransform(transform, x.transform)) return x;
            changed = true;
            return { ...x, transform: [...transform] };
        });
        if (changed) this.setInstances(next, name);
    }

    // ------------------------------------------------------------------ ILinkConsumer

    get attached(): boolean {
        let node = this.parent;
        const root = this.document.modelManager.rootNode;
        if ((this as INode) === root) return true;
        while (node !== undefined) {
            if (node === root) return true;
            node = node.parent;
        }
        return false;
    }

    linkSlots(): readonly LinkSlot[] {
        return this.instances.flatMap((x) =>
            x.source.kind === "link" ? [{ slotId: x.id, link: x.source.link }] : [],
        );
    }

    setLinkState(slotId: string, state: LinkState): void {
        this._states.set(slotId, state);
        this.geometryChanged.emit();
    }

    linkState(instanceId: string): LinkState | undefined {
        return this._states.get(instanceId);
    }

    applyLink(slotId: string, link: PartLinkData, message: string): void {
        const instance = this.instance(slotId);
        if (instance?.source.kind !== "link") return;
        Transaction.execute(this.document, message, () => {
            this.updateInstance(slotId, { source: { kind: "link", link } }, message);
            if (this.mates.length > 0) AssemblyNode.linkFollowUp?.(this);
        });
    }

    linkGeometryChanged(_slotId: string): void {
        this.geometryChanged.emit();
    }

    // ------------------------------------------------------------------ INodeWarning

    get warningCount(): number {
        let count = 0;
        for (const state of this._states.values()) {
            if (state.status !== "ok" && state.status !== "pending") count++;
        }
        return count;
    }

    get warningTooltip(): I18nKeys {
        return "assembly.linkWarnings{0}";
    }

    protected onVisibleChanged(): void {}

    protected onParentVisibleChanged(): void {}

    override disposeInternal(): void {
        this._registration?.dispose();
        this.geometryChanged.dispose();
        super.disposeInternal();
    }
}

function parseList<T>(json: string, owner: string): T[] {
    try {
        const parsed: unknown = JSON.parse(json);
        return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch (error) {
        Logger.warn(`assembly "${owner}": unreadable data`, error);
        return [];
    }
}

function sameTransform(a: readonly number[], b: readonly number[]): boolean {
    return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
}

export function isAssemblyNode(node: unknown): node is AssemblyNode {
    return node instanceof AssemblyNode;
}
