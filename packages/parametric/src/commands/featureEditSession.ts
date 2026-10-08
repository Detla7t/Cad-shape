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
import { featureHandler } from "../features/feature";
import type { ParametricBodyNode } from "../parametricBodyNode";

/** Owns the command slot so changing tools or documents awaits draft/picker cleanup. */
export class FeatureEditSession implements IFeatureEditSession, ICancelableCommand {
    closed = false;
    onClose?: () => void;
    private controller?: AsyncController;
    private pendingPick?: Promise<void>;
    private closing?: Promise<void>;
    private readonly hidden: INode[] = [];

    private constructor(
        readonly body: ParametricBodyNode,
        readonly featureId: string,
    ) {}

    static async start(body: ParametricBodyNode, id: string): Promise<Result<IFeatureEditSession>> {
        const app = body.document.application;
        const current = app.executingCommand;
        if (current) {
            if (!isCancelableCommand(current)) return Result.err("Finish the current command first.");
            await current.cancel();
        }
        const started = body.startFeatureDraft(id);
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
        return Result.ok(session);
    }

    async execute(_application: IApplication): Promise<void> {}
    dispose(): void {
        void this.cancel();
    }

    async pick(key?: string): Promise<void> {
        if (this.closed || this.closing || this.pendingPick) return;
        const controller = new AsyncController();
        this.controller = controller;
        this.pendingPick = this.body.reselectSession(this.featureId, controller, key);
        try {
            await this.pendingPick;
        } finally {
            controller.dispose();
            this.controller = undefined;
            this.pendingPick = undefined;
        }
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
        for (const node of this.hidden) setHistoryHidden(this.body.document, node, false);
        this.body.featureEditSession = undefined;
        const app = this.body.document.application;
        if (app.executingCommand === this) app.executingCommand = undefined;
        this.onClose?.();
    }
}
