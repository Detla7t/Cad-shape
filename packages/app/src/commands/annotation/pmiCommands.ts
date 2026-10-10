// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    Dimensions,
    documentUnits,
    type I18nKeys,
    type IApplication,
    type ICircle,
    type ICommand,
    type IEdge,
    type IShape,
    type IStep,
    isPmiAnnotation,
    type Matrix4,
    MultistepCommand,
    nextDatumLabel,
    nextFlagNumber,
    type PmiAnnotation,
    PmiDatum,
    PmiDimension,
    PmiFeatureControlFrame,
    PmiFlag,
    PmiNote,
    type PointSnapData,
    PointStep,
    PubSub,
    SelectShapeStep,
    type ShapeType,
    ShapeTypes,
    Transaction,
    XYZ,
} from "@chili3d/core";

/** Faces, edges and vertices all take a leader. */
const ANCHOR_SHAPES = (ShapeTypes.face | ShapeTypes.edge | ShapeTypes.vertex) as ShapeType;

/** The circle behind an edge, when it is a circle or an arc. */
export function circleOfEdge(shape: IShape): ICircle | undefined {
    if (shape.shapeType !== ShapeTypes.edge) return undefined;
    const curve = (shape as IEdge).curve;
    const basis = curve?.basisCurve ?? curve;
    return basis?.curveType === "circle" ? (basis as ICircle) : undefined;
}

/** The circle in world coordinates (the picked shape's transform applied). */
export function worldCircle(circle: ICircle, transform: Matrix4): { center: XYZ; axis: XYZ; radius: number } {
    return {
        center: transform.ofPoint(circle.center),
        axis: transform.ofVector(circle.axis).normalize() ?? XYZ.unitZ,
        radius: circle.radius,
    };
}

/**
 * The shared shape of the PMI commands: pick where the annotation refers to, then where its
 * frame sits; the node is added in one transaction and selected so the properties panel
 * opens on its text.
 */
abstract class PmiCommand extends MultistepCommand {
    protected anchorStep(prompt: I18nKeys = "prompt.annotation.pickAnchor"): IStep {
        return new SelectShapeStep(ANCHOR_SHAPES, prompt);
    }

    protected positionStep(from: () => XYZ): IStep {
        return new PointStep("prompt.annotation.pickPosition", (): PointSnapData => {
            return {
                refPoint: from,
                dimension: Dimensions.D1D2D3,
                preview: (point: XYZ | undefined) =>
                    point === undefined
                        ? [this.meshPoint(from())]
                        : [this.meshPoint(from()), this.meshLine(from(), point)],
            };
        });
    }

    /** The picked point of a step: the hit on a shape, or the snapped point. */
    protected pickedPoint(index: number): XYZ {
        const data = this.stepDatas[index];
        return data.shapes[0]?.point ?? data.point!;
    }

    protected addAnnotation(node: PmiAnnotation, transactionName: string): void {
        Transaction.execute(this.document, transactionName, () => {
            this.document.modelManager.addNode(node);
        });
        this.document.selection.setSelectedNodes([node], false);
        this.document.visual.update();
    }
}

@command({
    key: "annotation.note",
    icon: "icon-tag",
})
export class PmiNoteCommand extends PmiCommand {
    getSteps(): IStep[] {
        return [this.anchorStep(), this.positionStep(() => this.pickedPoint(0))];
    }

    protected override executeMainTask(): void {
        this.addAnnotation(
            new PmiNote({
                document: this.document,
                anchor: this.pickedPoint(0),
                position: this.pickedPoint(1),
                text: "NOTE",
            }),
            "create note",
        );
    }
}

/** The unit statement a general note opens with, from the document's display units. */
export function generalNoteText(unit: string): string {
    const names: Record<string, string> = {
        mm: "MILLIMETERS",
        cm: "CENTIMETERS",
        m: "METERS",
        in: "INCHES",
        ft: "FEET",
    };
    return `UNLESS OTHERWISE SPECIFIED:\nALL DIMENSIONS ARE IN ${names[unit] ?? unit.toUpperCase()}`;
}

@command({
    key: "annotation.generalNote",
    icon: "icon-tag",
})
export class PmiGeneralNoteCommand extends PmiCommand {
    getSteps(): IStep[] {
        return [new PointStep("prompt.annotation.pickPosition")];
    }

    protected override executeMainTask(): void {
        const position = this.pickedPoint(0);
        this.addAnnotation(
            new PmiNote({
                document: this.document,
                anchor: position,
                position,
                text: generalNoteText(documentUnits(this.document).length),
                leader: false,
                name: "General note",
            }),
            "create general note",
        );
    }
}

@command({
    key: "annotation.flag",
    icon: "icon-tag",
})
export class PmiFlagCommand extends PmiCommand {
    getSteps(): IStep[] {
        return [this.anchorStep(), this.positionStep(() => this.pickedPoint(0))];
    }

    protected override executeMainTask(): void {
        this.addAnnotation(
            new PmiFlag({
                document: this.document,
                anchor: this.pickedPoint(0),
                position: this.pickedPoint(1),
                text: String(nextFlagNumber(this.document)),
            }),
            "create flag note",
        );
    }
}

@command({
    key: "annotation.dimension",
    icon: "icon-dDimension",
})
export class PmiDimensionCommand extends PmiCommand {
    getSteps(): IStep[] {
        const first = new PointStep("prompt.pickFistPoint");
        const second = new PointStep("prompt.pickNextPoint", () => ({
            refPoint: () => this.pickedPoint(0),
            dimension: Dimensions.D1D2D3,
            preview: (point: XYZ | undefined) =>
                point === undefined
                    ? [this.meshPoint(this.pickedPoint(0))]
                    : [this.meshPoint(this.pickedPoint(0)), this.meshLine(this.pickedPoint(0), point)],
        }));
        return [first, second, this.positionStep(() => XYZ.center(this.pickedPoint(0), this.pickedPoint(1)))];
    }

    protected override executeMainTask(): void {
        const anchor = this.pickedPoint(0);
        const anchor2 = this.pickedPoint(1);
        this.addAnnotation(
            new PmiDimension({
                document: this.document,
                anchor,
                anchor2,
                position: this.pickedPoint(2),
                value: anchor.distanceTo(anchor2),
            }),
            "create dimension",
        );
    }
}

@command({
    key: "annotation.diameter",
    icon: "icon-dRadius",
})
export class PmiDiameterCommand extends PmiCommand {
    getSteps(): IStep[] {
        const circle = new SelectShapeStep(ShapeTypes.edge, "prompt.annotation.pickCircle", {
            shapeFilter: { allow: (shape) => circleOfEdge(shape) !== undefined },
        });
        return [circle, this.positionStep(() => this.circle()?.center ?? this.pickedPoint(0))];
    }

    private circle() {
        const picked = this.stepDatas[0]?.shapes[0];
        if (picked === undefined) return undefined;
        const circle = circleOfEdge(picked.shape);
        return circle === undefined ? undefined : worldCircle(circle, picked.transform);
    }

    protected override executeMainTask(): void {
        const circle = this.circle();
        if (circle === undefined) {
            PubSub.default.pub("showToast", "toast.annotation.notCircular");
            return;
        }
        this.addAnnotation(
            new PmiDimension({
                document: this.document,
                dimensionType: "diameter",
                anchor: circle.center,
                axis: circle.axis,
                position: this.pickedPoint(1),
                value: circle.radius * 2,
            }),
            "create diameter",
        );
    }
}

@command({
    key: "annotation.gdt",
    icon: "icon-position",
})
export class PmiFeatureControlFrameCommand extends PmiCommand {
    getSteps(): IStep[] {
        return [this.anchorStep(), this.positionStep(() => this.pickedPoint(0))];
    }

    protected override executeMainTask(): void {
        this.addAnnotation(
            new PmiFeatureControlFrame({
                document: this.document,
                anchor: this.pickedPoint(0),
                position: this.pickedPoint(1),
                symbol: "⌖",
                tolerance: "⌀0.1",
                datums: "A B",
            }),
            "create feature control frame",
        );
    }
}

@command({
    key: "annotation.datum",
    icon: "icon-cFix",
})
export class PmiDatumCommand extends PmiCommand {
    getSteps(): IStep[] {
        return [this.anchorStep(), this.positionStep(() => this.pickedPoint(0))];
    }

    protected override executeMainTask(): void {
        this.addAnnotation(
            new PmiDatum({
                document: this.document,
                anchor: this.pickedPoint(0),
                position: this.pickedPoint(1),
                label: nextDatumLabel(this.document),
            }),
            "create datum",
        );
    }
}

/** Selects every annotation of the document, so the properties panel styles them all at once. */
@command({ key: "annotation.selectAll", icon: "icon-annotation" })
export class PmiSelectAllCommand implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (document === undefined) return;
        const annotations = document.modelManager.findNodes((node) => isPmiAnnotation(node));
        document.selection.clearSelection();
        if (annotations.length > 0) document.selection.setSelectedNodes(annotations, false);
    }
}
