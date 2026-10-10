// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n } from "../i18n";
import { EVALUATION_READY, type EvaluationState, type IEvaluationStateSource } from "./evaluationState";
import { type FeatureItem, type IFeatureListNode, isFeatureListNode } from "./featureList";
import type { INode } from "./node";
import { ShapeNode } from "./shapeNode";

/**
 * The evaluation-state adapter of Part Studio results: features of a feature-list node (a
 * parametric body) and shape nodes. It reads the rebuild contract only — `FeatureItem.error`,
 * `ShapeNode.evaluationError`/`showsLastGoodShape`, `rollbackIndex` — so every panel derives
 * the same states:
 *
 * - a feature with an error is `failed` (with whether the body shows its last good shape);
 * - features after the failing one were not rebuilt by that run: `changed`;
 * - suppressed and rolled-back features are not evaluated by design: no state;
 * - a feature-list node fails at its first failing feature (named in the message, `at` its
 *   id); any other shape node fails with its `evaluationError`.
 *
 * Rebuilds are synchronous, so these sources never report `computing`.
 */

/** How a feature is named in messages; the panels pass their numbered names ("Fillet 2"). */
export type FeatureNamer = (item: FeatureItem) => string;

const defaultName: FeatureNamer = (item) => item.name ?? I18n.translate(item.display);

/** The properties whose change can move an evaluation state. */
const EVALUATION_PROPERTIES = new Set(["featuresJson", "shape", "evaluationError", "rollbackIndex"]);

export interface FeatureListEvaluationSnapshot {
    /** Per feature id; `undefined` for features not evaluated by design. */
    readonly features: ReadonlyMap<string, EvaluationState | undefined>;
    readonly node: EvaluationState;
}

function showsLastGood(node: INode): boolean {
    return node instanceof ShapeNode && node.showsLastGoodShape;
}

function shapeState(node: INode, lastGoodShown: boolean): EvaluationState {
    const error = node instanceof ShapeNode ? node.evaluationError : undefined;
    return error === undefined ? EVALUATION_READY : { kind: "failed", message: error, lastGoodShown };
}

/** The states of a feature-list node and of each of its features, from one `featureItems()` read. */
export function featureListEvaluation(
    node: INode & IFeatureListNode,
    nameOf: FeatureNamer = defaultName,
): FeatureListEvaluationSnapshot {
    const items = node.featureItems();
    const rollback = node.rollbackIndex;
    const lastGoodShown = showsLastGood(node);
    const failedIndex = items.findIndex((item) => item.error !== undefined && !item.suppressed);
    const failing = failedIndex < 0 ? undefined : items[failedIndex];
    const features = new Map<string, EvaluationState | undefined>();
    items.forEach((item, index) => {
        if (item.suppressed || (rollback !== undefined && index >= rollback)) {
            features.set(item.id, undefined);
        } else if (item.error !== undefined) {
            features.set(item.id, { kind: "failed", message: item.error, lastGoodShown, at: item.id });
        } else if (failing !== undefined && index > failedIndex) {
            features.set(item.id, {
                kind: "changed",
                reason: I18n.translate("evaluation.notRebuilt{0}", nameOf(failing)),
            });
        } else {
            features.set(item.id, EVALUATION_READY);
        }
    });
    const nodeState: EvaluationState =
        failing === undefined
            ? shapeState(node, lastGoodShown)
            : {
                  kind: "failed",
                  message: `${I18n.translate("evaluation.rebuildFailedAt{0}", nameOf(failing))}: ${failing.error}`,
                  lastGoodShown,
                  at: failing.id,
              };
    return { features, node: nodeState };
}

/** The state of any node: a feature-list node's (see `featureListEvaluation`) or a shape node's. */
export function nodeEvaluationState(node: INode, nameOf?: FeatureNamer): EvaluationState {
    if (isFeatureListNode(node)) return featureListEvaluation(node, nameOf).node;
    return shapeState(node, showsLastGood(node));
}

/**
 * Live evaluation sources over one node: the node's own state and one per feature. All of
 * them share one property listener on the node (attached while anything subscribes) and one
 * snapshot per change, so a list of N rows reads `featureItems()` once per rebuild, not N times.
 */
export class NodeEvaluation {
    private readonly listeners = new Set<() => void>();
    private cached: FeatureListEvaluationSnapshot | undefined;

    constructor(
        readonly target: INode,
        private readonly nameOf?: FeatureNamer,
    ) {}

    /** The node's own state. */
    readonly node: IEvaluationStateSource = {
        state: () => this.snapshot().node,
        subscribe: (listener) => this.subscribe(listener),
    };

    /** One feature's state (`undefined` for a feature not evaluated by design, or unknown). */
    feature(featureId: string): IEvaluationStateSource {
        return {
            state: () => this.snapshot().features.get(featureId),
            subscribe: (listener) => this.subscribe(listener),
        };
    }

    snapshot(): FeatureListEvaluationSnapshot {
        // Without a listener nothing would invalidate the cache: compute fresh.
        if (this.listeners.size === 0) return this.compute();
        this.cached ??= this.compute();
        return this.cached;
    }

    private compute(): FeatureListEvaluationSnapshot {
        if (isFeatureListNode(this.target)) return featureListEvaluation(this.target, this.nameOf);
        return { features: new Map(), node: nodeEvaluationState(this.target) };
    }

    private subscribe(listener: () => void): () => void {
        if (this.listeners.size === 0) this.target.onPropertyChanged(this.onChanged);
        this.listeners.add(listener);
        return () => {
            if (!this.listeners.delete(listener) || this.listeners.size > 0) return;
            this.target.removePropertyChanged(this.onChanged);
            this.cached = undefined;
        };
    }

    private readonly onChanged = (property: string | number | symbol) => {
        if (!EVALUATION_PROPERTIES.has(String(property))) return;
        this.cached = undefined;
        for (const listener of [...this.listeners]) listener();
    };
}
