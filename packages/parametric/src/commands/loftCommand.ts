// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    BoundingBox,
    CancelableCommand,
    Combobox,
    Continuities,
    type Continuity,
    command,
    commandTransactionName,
    type I18nKeys,
    Id,
    type IFace,
    type INode,
    type IShape,
    PubSub,
    property,
    Result,
    type ShapeMeshData,
    ShapeTypes,
    Transaction,
    VisualConfig,
    type VisualShapeData,
} from "@chili3d/core";
import type { BooleanOperation, LoftFeatureData } from "../features/feature";
import { DEFAULT_LOFT_CONTINUITY } from "../features/loft";
import { sketchProfiles } from "../features/profileBuilder";
import { captureProfileRef, type ProfileRef } from "../features/profileRef";
import { ParametricBodyNode } from "../parametricBodyNode";
import { SketchNode } from "../sketch/sketchNode";
import { SELECTED_PROFILE_STATE } from "./extrudeDragStep";
import { LoftPanel } from "./loftPanel";
import { prioritizeSketchFaces } from "./profileFaceSort";

const OPERATION_NEW: I18nKeys = "option.command.operation.new";

/** Maps the panel's operation to a boolean operation; "new" has none. */
const LOFT_OPERATIONS: Record<string, BooleanOperation> = {
    "option.command.operation.join": "fuse",
    "option.command.operation.cut": "cut",
    "option.command.operation.intersect": "common",
};

/** A picked loft section: the sketch, the profile region face it contributes and the face's fingerprint. */
interface LoftSection {
    sketch: SketchNode;
    face: IFace;
    ref: ProfileRef;
}

/**
 * The Loft feature command: pick two or more sketch profiles in order (viewport regions
 * or sketches in the feature tree), watch the live preview, accept. The result is a
 * parametric `loft` feature — on a new body, or joined/cut/intersected into the body
 * it overlaps — so editing any section sketch rebuilds the loft.
 */
@command({ key: "feature.loft", icon: "icon-loft" })
export class LoftFeatureCommand extends CancelableCommand {
    featureName = "Loft";
    private panel?: LoftPanel;
    private readonly sections: LoftSection[] = [];
    private previewMesh?: number;
    private previewShape: Result<IShape> = Result.err("");
    private confirmed = false;

    @property("option.command.isSolid")
    get solid(): boolean {
        return this.getPrivateValue("solid", true);
    }
    set solid(value: boolean) {
        this.setProperty("solid", value, () => this.refreshPreview());
    }

    @property("option.command.operation", {
        combobox: Combobox.from([
            OPERATION_NEW,
            "option.command.operation.join",
            "option.command.operation.cut",
            "option.command.operation.intersect",
        ] satisfies I18nKeys[]),
    })
    get operation(): I18nKeys {
        return this.getPrivateValue("operation", OPERATION_NEW);
    }
    set operation(value: I18nKeys) {
        this.setProperty("operation", value);
    }

    @property("option.command.isRuled")
    get ruled(): boolean {
        return this.getPrivateValue("ruled", false);
    }
    set ruled(value: boolean) {
        this.setProperty("ruled", value, () => this.refreshPreview());
    }

    @property("option.command.continuity", { combobox: Combobox.from([...Continuities]) })
    get continuity(): Continuity {
        return this.getPrivateValue("continuity", DEFAULT_LOFT_CONTINUITY);
    }
    set continuity(value: Continuity) {
        this.setProperty("continuity", value, () => this.refreshPreview());
    }

    // ------------------------------------------------------------------ Panel model

    get sectionLabels(): string[] {
        return this.sections.map((section) => `Face of ${section.sketch.name || "Sketch"}`);
    }

    get previewError(): string {
        return this.sections.length < 2 || this.previewShape.isOk ? "" : this.previewShape.error;
    }

    removeSection(index: number): void {
        if (index < 0 || index >= this.sections.length) return;
        this.sections.splice(index, 1);
        this.refreshPreview();
    }

    moveSection(index: number, delta: number): void {
        const target = index + delta;
        if (index < 0 || index >= this.sections.length || target < 0 || target >= this.sections.length)
            return;
        const [section] = this.sections.splice(index, 1);
        this.sections.splice(target, 0, section);
        this.refreshPreview();
    }

    reverseSections(): void {
        this.sections.reverse();
        this.refreshPreview();
    }

    // ------------------------------------------------------------------ Execution

    protected override async executeAsync(): Promise<void> {
        this.panel = new LoftPanel(
            this,
            () => this.confirm(),
            () => {
                void this.cancel();
            },
        );
        PubSub.default.pub("closeCommandContext");
        const selection = this.document.selection;
        this.seedFromSelection();
        selection.clearSelection();
        selection.onNodeChanged.sub(this.onNodesSelected);
        try {
            while (!this.confirmed) {
                this.controller = new AsyncController();
                const shapes = await this.document.picker.pickShape(
                    "prompt.select.section",
                    this.controller,
                    {
                        shapeType: ShapeTypes.face,
                        shapeFilter: { allow: (shape) => (shape as IFace).surface().isPlanar() },
                        nodeFilter: { allow: (node) => node instanceof SketchNode },
                        multi: false,
                        selectedState: SELECTED_PROFILE_STATE,
                        sortDetected: prioritizeSketchFaces,
                    },
                );
                if (this.confirmed) break;
                if (this.controller.result?.status !== "success" || shapes.length === 0) return;
                for (const picked of shapes) this.addPickedFace(picked);
                selection.clearSelection();
            }
            this.commit();
        } finally {
            selection.onNodeChanged.remove(this.onNodesSelected);
            this.clearPreview();
            this.panel.dispose();
            this.panel = undefined;
        }
    }

    /** The panel's ✓ (or Enter): ends the pick loop and commits when the preview is valid. */
    private confirm(): void {
        if (!this.panel?.canConfirm) return;
        this.confirmed = true;
        this.controller?.success();
    }

    /** Pre-selected sketches (whole: first outer profile) and sketch regions become the first sections. */
    private seedFromSelection(): void {
        const selection = this.document.selection;
        for (const node of selection.getSelectedNodes()) {
            if (node instanceof SketchNode) this.addSketch(node);
        }
        for (const picked of selection.getSelectedShapes()) {
            if (picked.owner.node instanceof SketchNode && picked.shape.shapeType === ShapeTypes.face)
                this.addPickedFace(picked);
        }
    }

    /** A sketch clicked in the feature tree contributes its first outer profile. */
    private readonly onNodesSelected = (nodes: INode[]) => {
        let added = false;
        for (const node of nodes) {
            if (node instanceof SketchNode && this.addSketch(node, false)) added = true;
        }
        if (added) {
            this.document.selection.clearSelection();
            this.refreshPreview();
        }
    };

    private addSketch(sketch: SketchNode, refresh = true): boolean {
        const profiles = sketchProfiles(sketch);
        const face = profiles.isOk ? profiles.value.outer[0] : undefined;
        if (face === undefined) {
            PubSub.default.pub(
                "showToast",
                "error.default:{0}",
                `${sketch.name} has no closed profile to loft`,
            );
            return false;
        }
        return this.addSection(sketch, face, refresh);
    }

    private addPickedFace(picked: VisualShapeData): void {
        const node = picked.owner.node;
        if (!(node instanceof SketchNode)) return;
        this.addSection(node, picked.shape as unknown as IFace);
    }

    /**
     * Appends a section unless the same region is already in the list (a region picked
     * twice, or a sketch clicked twice in the tree, rebuilds equal fingerprints);
     * returns whether it was added.
     */
    private addSection(sketch: SketchNode, face: IFace, refresh = true): boolean {
        const ref = captureProfileRef(face);
        const key = JSON.stringify(ref);
        if (this.sections.some((section) => section.sketch === sketch && JSON.stringify(section.ref) === key))
            return false;
        this.sections.push({ sketch, face, ref });
        if (refresh) this.refreshPreview();
        return true;
    }

    // ------------------------------------------------------------------ Preview

    private refreshPreview(): void {
        this.clearPreview();
        const meshes: ShapeMeshData[] = this.sections.map((section) => {
            const mesh = section.face.outerWire().mesh.edges!;
            return { ...mesh, color: VisualConfig.selectedEdgeColor, lineWidth: 3 };
        });
        if (this.sections.length >= 2) {
            this.previewShape = shapeFactory.loft(
                this.sections.map((section) => section.face.outerWire()),
                this.solid,
                this.ruled,
                this.continuity,
            );
            if (this.previewShape.isOk) {
                const faces = this.previewShape.value.mesh.faces;
                if (faces) meshes.push(faces);
            }
        } else {
            this.previewShape = Result.err("");
        }
        if (meshes.length > 0)
            this.previewMesh = this.document.visual.context.displayMesh(meshes, { meshOpacity: 0.5 });
        this.document.visual.update();
        this.panel?.refresh();
    }

    private clearPreview(): void {
        if (this.previewMesh !== undefined) {
            this.document.visual.context.removeMesh(this.previewMesh);
            this.previewMesh = undefined;
        }
        if (this.previewShape.isOk) this.previewShape.value.dispose();
        this.previewShape = Result.err("");
    }

    // ------------------------------------------------------------------ Commit

    private buildFeature(): LoftFeatureData {
        const operation = LOFT_OPERATIONS[this.operation];
        return {
            id: Id.generate(),
            type: "loft",
            ...(this.featureName === "Loft" ? {} : { name: this.featureName }),
            sections: this.sections.map((section) => ({ sketchId: section.sketch.id, profile: section.ref })),
            ...(this.solid ? {} : { solid: false }),
            ...(this.ruled ? { ruled: true } : {}),
            ...(this.continuity === DEFAULT_LOFT_CONTINUITY ? {} : { continuity: this.continuity }),
            ...(operation === undefined ? {} : { operation }),
        };
    }

    /**
     * Add/remove/intersect append the feature to the parametric body the loft overlaps
     * (bounding boxes); without one, or for "new", the loft becomes its own body. The
     * section sketches are hidden like extrude's, as the loft now shows their geometry.
     */
    private commit(): void {
        if (this.sections.length < 2 || !this.previewShape.isOk) return;
        const feature = this.buildFeature();
        const target = feature.operation === undefined ? undefined : this.findIntersectingBody();
        const sketches = [...new Set(this.sections.map((section) => section.sketch))];
        Transaction.execute(this.document, commandTransactionName(this), () => {
            if (target !== undefined) {
                target.setFeaturesEmitShapeChanged([...target.features, feature]);
            } else {
                this.document.modelManager.addNode(
                    new ParametricBodyNode({ document: this.document, features: [feature] }),
                );
            }
            for (const sketch of sketches) sketch.visible = false;
            this.document.visual.update();
        });
    }

    private findIntersectingBody(): ParametricBodyNode | undefined {
        if (!this.previewShape.isOk) return undefined;
        const box = this.previewShape.value.boundingBox();
        return this.document.modelManager.findNode(
            (target) =>
                target instanceof ParametricBodyNode &&
                target.shape.isOk &&
                BoundingBox.isIntersect(box, target.shape.value.boundingBox()),
        ) as ParametricBodyNode | undefined;
    }
}
