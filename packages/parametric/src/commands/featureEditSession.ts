// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    type IApplication,
    type ICancelableCommand,
    type IFeatureEditSession,
    type INode,
    isCancelableCommand,
    isHistoryHidden,
    Result,
    setHistoryHidden,
} from "@chili3d/core";
import { type FeatureData, featureHandler } from "../features/feature";
import type { ParametricBodyNode } from "../parametricBodyNode";
import { ExtrudeEditArrow } from "./extrudeEditArrow";

/** Owns the command slot so changing tools or documents awaits draft/picker cleanup. */
export class FeatureEditSession implements IFeatureEditSession, ICancelableCommand {
    closed = false;
    onClose?: () => void;
    onPickChanged?: () => void;
    private controller?: AsyncController;
    private pendingPick?: Promise<void>;
    private _activePick?: string;
    private manipulator?: ExtrudeEditArrow;
    private closing?: Promise<void>;
    private readonly hidden: INode[] = [];

    private constructor(
        readonly body: ParametricBodyNode,
        readonly featureId: string,
    ) {}

    /** `inserted` stages a new feature in the draft (see `ParametricBodyNode.startFeatureDraft`). */
    static async start(
        body: ParametricBodyNode,
        id: string,
        inserted?: FeatureData,
    ): Promise<Result<IFeatureEditSession>> {
        const app = body.document.application;
        const current = app.executingCommand;
        if (current) {
            if (!isCancelableCommand(current)) return Result.err("Finish the current command first.");
            await current.cancel();
        }
        const started = body.startFeatureDraft(id, inserted);
        if (!started.isOk) return Result.err(started.error);
        const session = new FeatureEditSession(body, id);
        const required = new Set<string>();
        const pending = body.features
            .slice(0, body.rollbackIndex)
            .flatMap((feature) => featureHandler(feature.type)?.nodeIds(feature) ?? []);
        while (pending.length) {
            const nodeId = pending.pop()!;
            if (required.has(nodeId) || nodeId === body.id) continue;
            required.add(nodeId);
            const node = body.document.modelManager.findNode((node) => node.id === nodeId);
            const features = (node as Partial<ParametricBodyNode> | undefined)?.features;
            if (features)
                for (const feature of features)
                    pending.push(...(featureHandler(feature.type)?.nodeIds(feature) ?? []));
            let parent = node?.parent;
            while (parent) {
                required.add(parent.id);
                parent = parent.parent;
            }
        }
        // Later top-level features/parts do not belong to the state being edited.
        let next = body.nextSibling;
        while (next) {
            if (!required.has(next.id) && !isHistoryHidden(next)) {
                session.hidden.push(next);
                setHistoryHidden(body.document, next, true);
            }
            next = next.nextSibling;
        }
        body.featureEditSession = session;
        app.executingCommand = session;
        // An extrude shows its depth arrow, as Onshape's dialog shows its manipulator.
        const view = app.activeView;
        if (view !== undefined && body.features.find((feature) => feature.id === id)?.type === "extrude")
            session.manipulator = new ExtrudeEditArrow(body, id, view);
        return Result.ok(session);
    }

    async execute(_application: IApplication): Promise<void> {}
    dispose(): void {
        void this.cancel();
    }

    get inserting(): boolean {
        return this.body.featureDraftInserting;
    }

    get activePick(): string | undefined {
        return this._activePick;
    }

    /**
     * Makes `key` the pick parameter taking selections. Like clicking another query box in
     * Onshape's dialog, activating a field while one is picking keeps what was picked there
     * and moves on; activating the picking field again just keeps it picking.
     */
    async pick(key?: string): Promise<void> {
        if (this.closed || this.closing) return;
        if (this.pendingPick) {
            if (key === this._activePick) return;
            this.controller?.success();
            await this.pendingPick.catch(() => {});
            // Another activation may have started its own pick while this one wound down.
            if (this.closed || this.isBusy()) return;
        }
        const controller = new AsyncController();
        this.controller = controller;
        this.setActivePick(key);
        this.pendingPick = this.body.reselectSession(this.featureId, controller, key);
        try {
            await this.pendingPick;
        } finally {
            controller.dispose();
            if (this.controller === controller) {
                this.controller = undefined;
                this.pendingPick = undefined;
                this.setActivePick(undefined);
            }
        }
    }

    private isBusy(): boolean {
        return this.closing !== undefined || this.pendingPick !== undefined;
    }

    private setActivePick(key: string | undefined): void {
        if (this._activePick === key) return;
        this._activePick = key;
        this.onPickChanged?.();
    }

    async apply(): Promise<Result<void>> {
        if (this.closed || this.closing) return Result.err("This edit session has closed.");
        this.controller?.success();
        try {
            await this.pendingPick;
        } catch (error) {
            return Result.err(String(error));
        }
        if (this.closed || this.closing) return Result.err("This edit session has closed.");
        const result = this.body.finishFeatureDraft(true);
        if (result.isOk) this.finish();
        return result;
    }

    async cancel(): Promise<void> {
        if (this.closed) return;
        this.closing ??= (async () => {
            this.controller?.cancel();
            try {
                await this.pendingPick;
            } finally {
                this.body.finishFeatureDraft(false);
                this.finish();
            }
        })();
        await this.closing;
    }

    private finish(): void {
        this.closed = true;
        this.manipulator?.dispose();
        this.manipulator = undefined;
        for (const node of this.hidden) setHistoryHidden(this.body.document, node, false);
        this.body.featureEditSession = undefined;
        const app = this.body.document.application;
        if (app.executingCommand === this) app.executingCommand = undefined;
        this.onClose?.();
    }
}
