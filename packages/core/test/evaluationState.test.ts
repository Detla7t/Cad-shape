// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    EVALUATION_READY,
    type EvaluationState,
    evaluationLabel,
    evaluationTooltip,
    type FeatureItem,
    featureListEvaluation,
    I18n,
    type IFeatureListNode,
    type INode,
    type IShapeMeshData,
    NodeEvaluation,
    nodeEvaluationState,
    Result,
    ShapeNode,
    sameEvaluationState,
} from "../src";
import { MockShape, TestDocument } from "../test-utils";

/** A shape node with a feature list: what a parametric body looks like to the adapter. */
class FakeBody extends ShapeNode {
    items: FeatureItem[] = [];
    rollbackIndex: number | undefined;
    reads = 0;

    display(): any {
        return "body.multiShape";
    }

    protected override createMesh(): IShapeMeshData {
        return { edges: undefined, faces: undefined, vertexs: undefined };
    }

    featureItems(): readonly FeatureItem[] {
        this.reads++;
        return this.items;
    }
    setFeatureParameter() {}
    setFeatureSuppressed() {}
    moveFeature() {}
    removeFeature() {}

    /** A rebuild: new feature errors, then the shape result (an error keeps the last good shape). */
    rebuild(items: FeatureItem[], shape: Result<any>) {
        this.items = items;
        this.setShape(shape);
        this.emitPropertyChanged("featuresJson" as any, "");
    }
}

class PlainShape extends ShapeNode {
    display(): any {
        return "body.multiShape";
    }
    protected override createMesh(): IShapeMeshData {
        return { edges: undefined, faces: undefined, vertexs: undefined };
    }
    set(shape: Result<any>) {
        this.setShape(shape);
    }
}

const feature = (id: string, patch: Partial<FeatureItem> = {}): FeatureItem => ({
    id,
    display: "command.feature.fuse",
    name: id.toUpperCase(),
    parameters: [],
    ...patch,
});

/** The class's `this`-typed observer signatures do not unify with the interface's; the shape does. */
const list = (node: FakeBody) => node as unknown as INode & IFeatureListNode;

function body() {
    const node = new FakeBody({ document: new TestDocument(), name: "Body" });
    node.rebuild([feature("a"), feature("b"), feature("c")], Result.ok(new MockShape()));
    return node;
}

describe("evaluation state vocabulary", () => {
    test("labels and tooltips name the state in words and carry the reason", () => {
        const failed: EvaluationState = { kind: "failed", message: "Edge not found", lastGoodShown: true };
        expect(evaluationLabel(failed)).toBe(I18n.translate("evaluation.failed"));
        expect(evaluationTooltip(failed)).toBe(
            `Edge not found\n${I18n.translate("evaluation.lastGoodShown")}`,
        );
        expect(evaluationTooltip({ ...failed, lastGoodShown: false })).toBe("Edge not found");
        expect(evaluationTooltip({ kind: "changed", reason: "The tool changed" })).toBe("The tool changed");
        expect(
            new Set(
                ["ready", "computing", "changed", "failed"].map((kind) =>
                    evaluationLabel({
                        kind,
                        reason: "",
                        message: "",
                        lastGoodShown: false,
                    } as EvaluationState),
                ),
            ).size,
        ).toBe(4);
    });

    test("sameEvaluationState compares by value", () => {
        expect(sameEvaluationState({ kind: "changed", reason: "x" }, { kind: "changed", reason: "x" })).toBe(
            true,
        );
        expect(sameEvaluationState({ kind: "changed", reason: "x" }, { kind: "changed", reason: "y" })).toBe(
            false,
        );
        expect(
            sameEvaluationState(
                { kind: "failed", message: "m", lastGoodShown: true, at: "f" },
                { kind: "failed", message: "m", lastGoodShown: false, at: "f" },
            ),
        ).toBe(false);
        expect(sameEvaluationState(EVALUATION_READY, { kind: "ready" })).toBe(true);
        expect(sameEvaluationState(undefined, EVALUATION_READY)).toBe(false);
    });
});

describe("Part Studio evaluation adapter", () => {
    test("a failed feature fails, later ones are out of date, the body shows its last good shape", () => {
        const node = body();
        node.rebuild(
            [
                feature("a"),
                feature("b", { error: "Edge not found" }),
                feature("c"),
                feature("d", { suppressed: true }),
            ],
            Result.err("Edge not found"),
        );
        expect(node.showsLastGoodShape).toBe(true);
        const { features, node: state } = featureListEvaluation(list(node));
        expect(features.get("a")).toEqual(EVALUATION_READY);
        expect(features.get("b")).toEqual({
            kind: "failed",
            message: "Edge not found",
            lastGoodShown: true,
            at: "b",
        });
        expect(features.get("c")).toEqual({
            kind: "changed",
            reason: I18n.translate("evaluation.notRebuilt{0}", "B"),
        });
        expect(features.has("d")).toBe(true);
        expect(features.get("d")).toBeUndefined();
        expect(state).toEqual({
            kind: "failed",
            message: `${I18n.translate("evaluation.rebuildFailedAt{0}", "B")}: Edge not found`,
            lastGoodShown: true,
            at: "b",
        });
    });

    test("the namer names the failing feature in messages", () => {
        const node = body();
        node.rebuild([feature("a", { error: "bad" }), feature("b")], Result.err("bad"));
        const { features } = featureListEvaluation(list(node), (item) => `Fillet ${item.id}`);
        expect(features.get("b")).toEqual({
            kind: "changed",
            reason: I18n.translate("evaluation.notRebuilt{0}", "Fillet a"),
        });
    });

    test("rolled-back features have no state, and a recovered body is ready", () => {
        const node = body();
        node.rollbackIndex = 1;
        const rolled = featureListEvaluation(list(node)).features;
        expect(rolled.get("a")).toEqual(EVALUATION_READY);
        expect(rolled.get("b")).toBeUndefined();
        expect(rolled.get("c")).toBeUndefined();
        node.rollbackIndex = undefined;
        node.rebuild([feature("a", { error: "bad" })], Result.err("bad"));
        node.rebuild([feature("a")], Result.ok(new MockShape()));
        expect(node.showsLastGoodShape).toBe(false);
        expect(nodeEvaluationState(node)).toEqual(EVALUATION_READY);
    });

    test("a plain shape node fails with its evaluation error, without last good geometry when it never built", () => {
        const node = new PlainShape({ document: new TestDocument(), name: "Sketch" });
        node.set(Result.err("Open profile"));
        expect(nodeEvaluationState(node)).toEqual({
            kind: "failed",
            message: "Open profile",
            lastGoodShown: false,
        });
        node.set(Result.ok(new MockShape()));
        expect(nodeEvaluationState(node)).toEqual(EVALUATION_READY);
        node.set(Result.err("Open profile"));
        expect(nodeEvaluationState(node)).toMatchObject({ kind: "failed", lastGoodShown: true });
    });

    test("NodeEvaluation shares one listener and one snapshot per change across a list's rows", () => {
        const node = body();
        const evaluation = new NodeEvaluation(node);
        const a = evaluation.feature("a");
        const c = evaluation.feature("c");
        const heard: string[] = [];
        const stopA = a.subscribe(() => heard.push("a"));
        const stopC = c.subscribe(() => heard.push("c"));

        node.reads = 0;
        expect(a.state()).toEqual(EVALUATION_READY);
        expect(c.state()).toEqual(EVALUATION_READY);
        expect(evaluation.node.state()).toEqual(EVALUATION_READY);
        expect(node.reads).toBe(1);

        node.rebuild([feature("a"), feature("b", { error: "bad" }), feature("c")], Result.err("bad"));
        expect(heard.filter((x) => x === "a").length).toBeGreaterThan(0);
        expect(heard.filter((x) => x === "c").length).toBeGreaterThan(0);
        expect(c.state()?.kind).toBe("changed");
        expect(evaluation.node.state()).toMatchObject({ kind: "failed", at: "b", lastGoodShown: true });

        heard.length = 0;
        node.name = "Renamed";
        expect(heard).toEqual([]);

        stopA();
        stopC();
        node.rebuild([feature("a")], Result.ok(new MockShape()));
        expect(heard).toEqual([]);
        // Unsubscribed: reads are fresh again.
        expect(c.state()).toBeUndefined();
        expect(evaluation.node.state()).toEqual(EVALUATION_READY);
    });
});
