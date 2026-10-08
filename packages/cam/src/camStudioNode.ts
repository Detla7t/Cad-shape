// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    Id,
    type INode,
    type INodeIcon,
    type INodeSceneless,
    Logger,
    Node,
    serializable,
    serialize,
} from "@chili3d/core";
import type { MachineProfileData } from "./model/machine";
import type { SetupData } from "./model/setup";

export interface CamStudioNodeOptions {
    document: IDocument;
    name?: string;
    id?: string;
    /** The stored setups, as a loaded document hands them back. */
    setupsJson?: string;
    setups?: readonly SetupData[];
    /** The document's own machine profiles (edited or imported here), as stored. */
    machinesJson?: string;
    machines?: readonly MachineProfileData[];
}

/**
 * A CAM Studio: the document element (a bottom tab) that holds machining and printing
 * setups for the Part Studio's parts. Like a parametric body it stores no geometry, only
 * data — setups, their operations and tools — and toolpaths are regenerated from the live
 * parts, so a model change flows into the programs.
 *
 * `setupsJson` is a recorded property: an edit is one undo step (and one microversion).
 */
@serializable()
export class CamStudioNode extends Node implements INodeIcon, INodeSceneless {
    private readonly disposalListeners = new Set<() => void>();

    /** Runtime services share the studio's lifetime, independently of its open views. */
    onDispose(listener: () => void): () => void {
        this.disposalListeners.add(listener);
        return () => this.disposalListeners.delete(listener);
    }

    override disposeInternal(): void {
        for (const listener of [...this.disposalListeners]) listener();
        this.disposalListeners.clear();
        super.disposeInternal();
    }

    get icon(): string {
        return "icon-cog";
    }

    readonly sceneless = true as const;

    constructor(options: CamStudioNodeOptions) {
        super(options.document, options.name ?? "CAM Studio", options.id ?? Id.generate());
        this.setPrivateValue("setupsJson", options.setupsJson ?? JSON.stringify(options.setups ?? []));
        this.setPrivateValue("machinesJson", options.machinesJson ?? JSON.stringify(options.machines ?? []));
    }

    @serialize()
    get setupsJson(): string {
        return this.getPrivateValue("setupsJson");
    }
    set setupsJson(value: string) {
        this.setProperty("setupsJson", value);
    }

    get setups(): readonly SetupData[] {
        try {
            const parsed: unknown = JSON.parse(this.setupsJson);
            return Array.isArray(parsed) ? (parsed as SetupData[]) : [];
        } catch (error) {
            Logger.warn(`CAM Studio "${this.name}": unreadable setups`, error);
            return [];
        }
    }

    setSetups(setups: readonly SetupData[]): void {
        this.setupsJson = JSON.stringify(setups);
    }

    /**
     * Machine profiles kept in the document: a profile edited or imported in this studio
     * travels with the document (and its versions) and shadows a library profile with the
     * same id. Recorded like `setupsJson`.
     */
    @serialize()
    get machinesJson(): string {
        return this.getPrivateValue("machinesJson") ?? "[]";
    }
    set machinesJson(value: string) {
        this.setProperty("machinesJson", value);
    }

    get machines(): readonly MachineProfileData[] {
        try {
            const parsed: unknown = JSON.parse(this.machinesJson);
            return Array.isArray(parsed) ? (parsed as MachineProfileData[]) : [];
        } catch (error) {
            Logger.warn(`CAM Studio "${this.name}": unreadable machine profiles`, error);
            return [];
        }
    }

    setMachines(machines: readonly MachineProfileData[]): void {
        this.machinesJson = JSON.stringify(machines);
    }

    protected onVisibleChanged(): void {}

    protected onParentVisibleChanged(): void {}
}

export function isCamStudioNode(node: INode): node is CamStudioNode {
    return node instanceof CamStudioNode;
}
