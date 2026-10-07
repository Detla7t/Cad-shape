// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    type AsyncController,
    Combobox,
    CurveUtils,
    command,
    commandTransactionName,
    GetOrSelectNodeStep,
    type I18nKeys,
    type IDocument,
    Id,
    type IEdge,
    type IFace,
    type INode,
    type IShape,
    type IShapeFilter,
    type IStep,
    LENGTH_UNITS,
    MultistepCommand,
    type ParameterValue,
    PubSub,
    property,
    SelectShapeStep,
    ShapeNode,
    ShapeTypes,
    type SnapResult,
    Transaction,
    UNITLESS,
    VisualStates,
} from "@chili3d/core";
import { SelectSketchProfilesStep } from "../commands/extrudeCommand";
import { captureEdgeRef } from "../features/edgeRef";
import type { SheetMetalEdgeFeatureData, SheetMetalFeatureData } from "../features/feature";
import { captureProfileRef } from "../features/profileRef";
import { ParametricBodyNode } from "../parametricBodyNode";
import { SketchNode } from "../sketch/sketchNode";
import { captureSheetLine, EDGE_LENGTH_DEFAULT } from "./features";
import { sheetModelOf } from "./model";
import { DEFAULTS } from "./treatments";

/**
 * Sheet metal commands: each picks what it needs, takes its values from the command's
 * options panel, and appends one feature to the sheet metal body as one undo step. Every
 * value stays editable afterwards in the body's feature list.
 */

function sheetBody(node: INode | undefined): ParametricBodyNode | undefined {
    if (!(node instanceof ParametricBodyNode)) return undefined;
    const shape = node.shape;
    return shape.isOk && sheetModelOf(shape.value) !== undefined ? node : undefined;
}

const isSheetBody = (node: INode) => sheetBody(node) !== undefined;

function append(
    document: IDocument,
    body: ParametricBodyNode,
    feature: SheetMetalFeatureData,
    name: string,
    consumed: readonly INode[] = [],
): void {
    Transaction.execute(document, name, () => {
        body.setFeaturesEmitShapeChanged([...body.features, feature]);
        // Sketches the feature consumed hide, as extrude and revolve hide theirs.
        for (const node of consumed) if (node instanceof SketchNode) node.visible = false;
        document.visual.update();
    });
    document.selection.setSelectedNodes([body], false);
}

class LineEdgeFilter implements IShapeFilter {
    allow(shape: IShape): boolean {
        return shape.shapeType === ShapeTypes.edge && CurveUtils.isLine((shape as IEdge).curve.basisCurve);
    }
}

const DIRECTIONS = () => Combobox.from<I18nKeys>(["sheetMetal.up", "sheetMetal.down"]);
const ENDS = () => Combobox.from<I18nKeys>(["sheetMetal.finish", "sheetMetal.start"]);

// ------------------------------------------------------------------ Base

@command({ key: "sheetMetal.base", icon: "icon-thickSolid" })
export class SheetMetalBaseCommand extends MultistepCommand {
    @property("sheetMetal.thickness", { unit: LENGTH_UNITS })
    get thickness(): ParameterValue {
        return this.getPrivateValue("thickness", 1);
    }
    set thickness(value: ParameterValue) {
        this.setProperty("thickness", value);
    }

    @property("sheetMetal.radius", { unit: LENGTH_UNITS })
    get radius(): ParameterValue {
        return this.getPrivateValue("radius", 1);
    }
    set radius(value: ParameterValue) {
        this.setProperty("radius", value);
    }

    @property("sheetMetal.kFactor", { unit: UNITLESS })
    get kFactor(): ParameterValue {
        return this.getPrivateValue("kFactor", 0.44);
    }
    set kFactor(value: ParameterValue) {
        this.setProperty("kFactor", value);
    }

    protected override getSteps(): IStep[] {
        return [new SelectSketchProfilesStep((node) => node instanceof SketchNode)];
    }

    protected override executeMainTask(): void {
        const sketch = this.stepDatas[0].nodes?.[0] as unknown as SketchNode;
        const faces = this.stepDatas[0].shapes.map((x) => x.shape as unknown as IFace);
        const body = new ParametricBodyNode({
            document: this.document,
            features: [
                {
                    id: Id.generate(),
                    type: "smBase",
                    sketchId: sketch.id,
                    thickness: this.thickness,
                    radius: this.radius,
                    kFactor: this.kFactor,
                    ...(faces.length > 0 ? { profiles: faces.map((face) => captureProfileRef(face)) } : {}),
                },
            ],
        });
        Transaction.execute(this.document, commandTransactionName(this), () => {
            this.document.modelManager.addNode(body);
            sketch.visible = false;
            this.document.visual.update();
        });
    }
}

// ------------------------------------------------------------------ Bend lines

@command({ key: "sheetMetal.bend", icon: "icon-dAngle" })
export class SheetMetalBendCommand extends MultistepCommand {
    @property("sheetMetal.angle", { unit: ANGLE_UNITS })
    get angle(): ParameterValue {
        return this.getPrivateValue("angle", 90);
    }
    set angle(value: ParameterValue) {
        this.setProperty("angle", value);
    }

    @property("sheetMetal.direction", { combobox: DIRECTIONS() })
    get direction(): I18nKeys {
        return this.getPrivateValue("direction", "sheetMetal.up");
    }
    set direction(value: I18nKeys) {
        this.setProperty("direction", value);
    }

    protected override getSteps(): IStep[] {
        return [
            new GetOrSelectNodeStep("prompt.select.models", { filter: { allow: isSheetBody } }),
            new SelectShapeStep(ShapeTypes.edge, "prompt.select.edges", {
                multiple: true,
                shapeFilter: new LineEdgeFilter(),
                nodeFilter: { allow: (node) => node instanceof ShapeNode && !isSheetBody(node) },
                selectedState: VisualStates.edgeSelected,
                highlightState: VisualStates.edgeHighlight,
            }),
        ];
    }

    protected override executeMainTask(): void {
        const body = sheetBody(this.stepDatas[0].nodes?.[0]);
        if (body === undefined) return;
        const lines = this.stepDatas[1].shapes.map((data) =>
            captureSheetLine(data.owner.node.id, data.shape as unknown as IEdge, data.transform),
        );
        append(
            this.document,
            body,
            {
                id: Id.generate(),
                type: "smBend",
                lines,
                angle: this.angle,
                direction: this.direction === "sheetMetal.down" ? "down" : "up",
            },
            commandTransactionName(this),
            this.stepDatas[1].shapes.map((data) => data.owner.node),
        );
    }
}

// ------------------------------------------------------------------ Edge treatments

abstract class SheetMetalEdgeCommand extends MultistepCommand {
    protected abstract readonly kind: SheetMetalEdgeFeatureData["kind"];

    @property("sheetMetal.length", { unit: LENGTH_UNITS })
    get length(): ParameterValue {
        return this.getPrivateValue("length", Math.round(EDGE_LENGTH_DEFAULT[this.kind] * 100) / 100);
    }
    set length(value: ParameterValue) {
        this.setProperty("length", value);
    }

    @property("sheetMetal.direction", { combobox: DIRECTIONS() })
    get direction(): I18nKeys {
        return this.getPrivateValue("direction", "sheetMetal.up");
    }
    set direction(value: I18nKeys) {
        this.setProperty("direction", value);
    }

    protected override getSteps(): IStep[] {
        return [
            new SelectShapeStep(ShapeTypes.edge, "prompt.select.edges", {
                multiple: true,
                shapeFilter: new LineEdgeFilter(),
                nodeFilter: { allow: isSheetBody },
                selectedState: VisualStates.edgeSelected,
                highlightState: VisualStates.edgeHighlight,
            }),
        ];
    }

    protected extra(): Partial<SheetMetalEdgeFeatureData> {
        return {};
    }

    protected override executeMainTask(): void {
        const picked = this.stepDatas[0].shapes;
        const body = sheetBody(picked[0]?.owner.node);
        if (body === undefined) return;
        const edges = picked
            .filter((data) => data.owner.node === body)
            .map((data) => captureEdgeRef(data.shape as unknown as IEdge));
        append(
            this.document,
            body,
            {
                id: Id.generate(),
                type: "smEdge",
                kind: this.kind,
                edges,
                length: this.length,
                direction: this.direction === "sheetMetal.down" ? "down" : "up",
                ...this.extra(),
            },
            commandTransactionName(this),
        );
    }
}

/** The male half of a Pittsburgh lock: a 90° leg that slides into the pocket. */
@command({ key: "sheetMetal.easyEdge", icon: "icon-extend" })
export class EasyEdgeCommand extends SheetMetalEdgeCommand {
    protected readonly kind = "easyEdge" as const;
}

/** The female half of a Pittsburgh lock: the pocket and its hammer-over lip. */
@command({ key: "sheetMetal.pittsburgh", icon: "icon-sew" })
export class PittsburghCommand extends SheetMetalEdgeCommand {
    protected readonly kind = "pittsburgh" as const;

    @property("sheetMetal.lipHeight", { unit: LENGTH_UNITS })
    get height(): ParameterValue {
        return this.getPrivateValue("height", Math.round(DEFAULTS.lipHeight * 100) / 100);
    }
    set height(value: ParameterValue) {
        this.setProperty("height", value);
    }

    protected override extra(): Partial<SheetMetalEdgeFeatureData> {
        return { height: this.height };
    }
}

@command({ key: "sheetMetal.hem", icon: "icon-offset" })
export class HemCommand extends SheetMetalEdgeCommand {
    protected readonly kind = "hem" as const;
}

@command({ key: "sheetMetal.flange", icon: "icon-fromSection" })
export class FlangeCommand extends SheetMetalEdgeCommand {
    protected readonly kind = "flange" as const;

    @property("sheetMetal.angle", { unit: ANGLE_UNITS })
    get angle(): ParameterValue {
        return this.getPrivateValue("angle", 90);
    }
    set angle(value: ParameterValue) {
        this.setProperty("angle", value);
    }

    protected override extra(): Partial<SheetMetalEdgeFeatureData> {
        return { angle: this.angle };
    }
}

// ------------------------------------------------------------------ Round duct and flatten

abstract class SheetBodyCommand extends MultistepCommand {
    protected override getSteps(): IStep[] {
        return [new GetOrSelectNodeStep("prompt.select.models", { filter: { allow: isSheetBody } })];
    }

    protected get body(): ParametricBodyNode | undefined {
        return sheetBody(this.stepDatas[0]?.nodes?.[0]);
    }
}

@command({ key: "sheetMetal.roll", icon: "icon-cylinder" })
export class RollCommand extends SheetBodyCommand {
    @property("sheetMetal.axis", {
        combobox: Combobox.from<I18nKeys>(["sheetMetal.axisY", "sheetMetal.axisX"]),
    })
    get axis(): I18nKeys {
        return this.getPrivateValue("axis", "sheetMetal.axisY");
    }
    set axis(value: I18nKeys) {
        this.setProperty("axis", value);
    }

    @property("sheetMetal.rollRadius", { unit: LENGTH_UNITS })
    get radius(): ParameterValue {
        return this.getPrivateValue("radius", 0);
    }
    set radius(value: ParameterValue) {
        this.setProperty("radius", value);
    }

    @property("sheetMetal.direction", { combobox: DIRECTIONS() })
    get direction(): I18nKeys {
        return this.getPrivateValue("direction", "sheetMetal.up");
    }
    set direction(value: I18nKeys) {
        this.setProperty("direction", value);
    }

    protected override executeMainTask(): void {
        const body = this.body;
        if (body === undefined) return;
        append(
            this.document,
            body,
            {
                id: Id.generate(),
                type: "smRoll",
                axis: this.axis === "sheetMetal.axisX" ? "u" : "v",
                radius: this.radius,
                direction: this.direction === "sheetMetal.down" ? "down" : "up",
            },
            commandTransactionName(this),
        );
    }
}

@command({ key: "sheetMetal.crimp", icon: "icon-pipe" })
export class CrimpCommand extends SheetBodyCommand {
    @property("sheetMetal.end", { combobox: ENDS() })
    get end(): I18nKeys {
        return this.getPrivateValue("end", "sheetMetal.finish");
    }
    set end(value: I18nKeys) {
        this.setProperty("end", value);
    }

    @property("sheetMetal.length", { unit: LENGTH_UNITS })
    get length(): ParameterValue {
        return this.getPrivateValue("length", 38.1);
    }
    set length(value: ParameterValue) {
        this.setProperty("length", value);
    }

    @property("sheetMetal.depth", { unit: LENGTH_UNITS })
    get depth(): ParameterValue {
        return this.getPrivateValue("depth", 1.5);
    }
    set depth(value: ParameterValue) {
        this.setProperty("depth", value);
    }

    @property("sheetMetal.count", { unit: UNITLESS })
    get count(): ParameterValue {
        return this.getPrivateValue("count", 36);
    }
    set count(value: ParameterValue) {
        this.setProperty("count", value);
    }

    protected override executeMainTask(): void {
        const body = this.body;
        if (body === undefined) return;
        append(
            this.document,
            body,
            {
                id: Id.generate(),
                type: "smCrimp",
                end: this.end === "sheetMetal.start" ? "start" : "end",
                length: this.length,
                depth: this.depth,
                count: this.count,
            },
            commandTransactionName(this),
        );
    }
}

/** A step that only runs while `condition` holds; otherwise it succeeds with nothing picked. */
class ConditionalStep implements IStep {
    constructor(
        private readonly inner: IStep,
        private readonly condition: () => boolean,
    ) {}

    async execute(document: IDocument, controller: AsyncController): Promise<SnapResult | undefined> {
        if (this.condition()) return this.inner.execute(document, controller);
        controller.success();
        return { view: document.application.activeView!, shapes: [], nodes: [], type: "shape" };
    }
}

/**
 * A bead: around a rolled duct (ring, `offset` from an end), or along a picked sketch line
 * on a flat sheet.
 */
@command({ key: "sheetMetal.bead", icon: "icon-arc3point" })
export class BeadCommand extends SheetBodyCommand {
    @property("sheetMetal.width", { unit: LENGTH_UNITS })
    get width(): ParameterValue {
        return this.getPrivateValue("width", 8);
    }
    set width(value: ParameterValue) {
        this.setProperty("width", value);
    }

    @property("sheetMetal.height", { unit: LENGTH_UNITS })
    get height(): ParameterValue {
        return this.getPrivateValue("height", 3);
    }
    set height(value: ParameterValue) {
        this.setProperty("height", value);
    }

    @property("sheetMetal.offset", { unit: LENGTH_UNITS })
    get offset(): ParameterValue {
        return this.getPrivateValue("offset", 50);
    }
    set offset(value: ParameterValue) {
        this.setProperty("offset", value);
    }

    @property("sheetMetal.direction", {
        combobox: Combobox.from<I18nKeys>(["sheetMetal.out", "sheetMetal.in"]),
    })
    get direction(): I18nKeys {
        return this.getPrivateValue("direction", "sheetMetal.out");
    }
    set direction(value: I18nKeys) {
        this.setProperty("direction", value);
    }

    private rolled(): boolean {
        const body = this.body;
        return body !== undefined && sheetModelOf(body.shape.value)?.roll !== undefined;
    }

    protected override getSteps(): IStep[] {
        return [
            ...super.getSteps(),
            new ConditionalStep(
                new SelectShapeStep(ShapeTypes.edge, "prompt.select.edges", {
                    shapeFilter: new LineEdgeFilter(),
                    nodeFilter: { allow: (node) => node instanceof ShapeNode && !isSheetBody(node) },
                }),
                () => !this.rolled(),
            ),
        ];
    }

    protected override executeMainTask(): void {
        const body = this.body;
        if (body === undefined) return;
        const line = this.stepDatas[1]?.shapes[0];
        if (line === undefined && !this.rolled()) {
            PubSub.default.pub("showToast", "toast.select.noSelected");
            return;
        }
        append(
            this.document,
            body,
            {
                id: Id.generate(),
                type: "smBead",
                width: this.width,
                height: this.height,
                direction: this.direction === "sheetMetal.in" ? "in" : "out",
                ...(line === undefined
                    ? { offset: this.offset, from: "end" as const }
                    : {
                          line: captureSheetLine(
                              line.owner.node.id,
                              line.shape as unknown as IEdge,
                              line.transform,
                          ),
                      }),
            },
            commandTransactionName(this),
            line === undefined ? [] : [line.owner.node],
        );
    }
}

/** Toggles the flat pattern: adds a Flatten feature, or removes the one already at the end. */
@command({ key: "sheetMetal.flatten", icon: "icon-toFace" })
export class FlattenCommand extends SheetBodyCommand {
    protected override getSteps(): IStep[] {
        return [
            new GetOrSelectNodeStep("prompt.select.models", {
                filter: {
                    allow: (node) =>
                        node instanceof ParametricBodyNode && (isSheetBody(node) || hasFlatten(node)),
                },
            }),
        ];
    }

    protected override executeMainTask(): void {
        const body = this.stepDatas[0].nodes?.[0];
        if (!(body instanceof ParametricBodyNode)) return;
        const existing = body.features.find((feature) => feature.type === "smFlatten");
        if (existing !== undefined) {
            Transaction.execute(this.document, commandTransactionName(this), () => {
                body.removeFeature(existing.id);
                this.document.visual.update();
            });
            return;
        }
        append(this.document, body, { id: Id.generate(), type: "smFlatten" }, commandTransactionName(this));
    }
}

function hasFlatten(body: ParametricBodyNode): boolean {
    return body.features.some((feature) => feature.type === "smFlatten");
}
