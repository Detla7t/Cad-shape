// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type I18nKeys,
    type IDocument,
    type ParameterValue,
    Plane,
    PubSub,
    property,
    type Result,
    serializable,
    serialize,
} from "@chili3d/core";
import { DocumentFileNode } from "@chili3d/documents";
import { type SketchData, SketchNode, type SketchNodeOptions } from "@chili3d/parametric";
import { endCapDxf } from "../endcap/batch";
import { type EndCapParams, endCapName, validateEndCap } from "../endcap/endCap";
import { formatFractionalInches } from "../endcap/inches";
import { defaultWallHeight } from "../endcap/sizes";
import { configuredEndCapValues, type EndCapValues, resolveEndCapValues } from "./endCapConfiguration";
import { endCapSketchData } from "./endCapSketch";

export interface EndCapSketchNodeOptions extends Omit<SketchNodeOptions, "plane"> {
    plane?: Plane;
    endcap?: ParameterValue;
    outerDiameter?: ParameterValue;
    innerDiameter?: ParameterValue;
    wallHeight?: ParameterValue;
    /** The parameters the stored sketch data was generated for (serialized). */
    generatedFor?: string;
    /** A drawing element (DXF) kept equal to the flat pattern. */
    drawingId?: string;
}

/**
 * The End Cap as a Part Studio feature: a sketch whose geometry is the end cap's flat pattern,
 * driven by four parameter expressions — by default bound to the document's End Cap
 * configuration (`endCapConfiguration.ts`), so switching OD, ID, Endcap or Wall Height in the
 * Configurations panel redraws it, like the Onshape Part Studio. The values are editable in
 * the properties panel too (any expression, a variable, a fixed size).
 *
 * It is a sketch through and through — regions for extrude and sheet metal, CAM loops, sketch
 * DXF export — so a regeneration replaces the sketch's geometry; edits made in the sketch
 * editor last until the configuration changes the cap. A linked drawing element (the
 * template's "End Cap Drawing") is rewritten with the cut-ready DXF on every regeneration.
 */
@serializable({ id: "EndCapSketchNode" })
export class EndCapSketchNode extends SketchNode {
    private _error: string | undefined;

    @serialize()
    get endcap(): ParameterValue {
        return this.getPrivateValue("endcap");
    }
    set endcap(value: ParameterValue) {
        this.setValue("endcap", value);
    }

    /**
     * The values are expressions (`configure(OD, …)` by default) set in the Configurations
     * panel; the properties panel shows what they resolve to (below), read-only, so a click in
     * a field can never replace a configured expression. OD/ID are not `od`/`id`: `id` is
     * every node's identity.
     */
    @serialize()
    get outerDiameter(): ParameterValue {
        return this.getPrivateValue("outerDiameter");
    }
    set outerDiameter(value: ParameterValue) {
        this.setValue("outerDiameter", value);
    }

    @serialize()
    get innerDiameter(): ParameterValue {
        return this.getPrivateValue("innerDiameter");
    }
    set innerDiameter(value: ParameterValue) {
        this.setValue("innerDiameter", value);
    }

    @serialize()
    get wallHeight(): ParameterValue {
        return this.getPrivateValue("wallHeight");
    }
    set wallHeight(value: ParameterValue) {
        this.setValue("wallHeight", value);
    }

    @serialize()
    get generatedFor(): string {
        return this.getPrivateValue("generatedFor", "");
    }

    @serialize()
    get drawingId(): string | undefined {
        return this.getPrivateValue("drawingId");
    }
    set drawingId(value: string | undefined) {
        this.setProperty("drawingId", value);
    }

    constructor(options: EndCapSketchNodeOptions) {
        super({ ...options, plane: options.plane ?? Plane.XY });
        const values = configuredEndCapValues();
        this.setPrivateValue("endcap", options.endcap ?? values.endcap);
        this.setPrivateValue("outerDiameter", options.outerDiameter ?? values.od);
        this.setPrivateValue("innerDiameter", options.innerDiameter ?? values.id);
        this.setPrivateValue("wallHeight", options.wallHeight ?? values.wallHeight);
        this.setPrivateValue("generatedFor", options.generatedFor ?? "");
        this.setPrivateValue("drawingId", options.drawingId);
    }

    /** A new end cap in `document`, drawn for the document's current configuration. */
    static create(document: IDocument, values: Partial<EndCapValues> = {}): EndCapSketchNode {
        const node = new EndCapSketchNode({
            document,
            endcap: values.endcap,
            outerDiameter: values.od,
            innerDiameter: values.id,
            wallHeight: values.wallHeight,
        });
        node.name = "End Cap";
        node.regenerate(true);
        return node;
    }

    get values(): EndCapValues {
        return {
            endcap: this.endcap,
            od: this.outerDiameter,
            id: this.innerDiameter,
            wallHeight: this.wallHeight,
        };
    }

    /** The cap as the properties panel shows it: its name, or what is wrong with the configuration. */
    @property("endCap.size")
    get size(): string {
        const params = this.resolve();
        if (!params.isOk) return `⚠ ${params.error}`;
        const problem = validateEndCap(params.value);
        return problem === undefined ? endCapName(params.value) : `⚠ ${problem}`;
    }

    @property("endCap.od")
    get outerDiameterLabel(): string {
        const params = this.resolve();
        return params.isOk ? formatFractionalInches(params.value.od) : "";
    }

    @property("endCap.id")
    get innerDiameterLabel(): string {
        const params = this.resolve();
        return params.isOk && params.value.reducing && params.value.id !== undefined
            ? formatFractionalInches(params.value.id)
            : "—";
    }

    @property("endCap.wallHeight")
    get wallHeightLabel(): string {
        const params = this.resolve();
        if (!params.isOk || !params.value.reducing) return "—";
        const wall = params.value.wallHeight;
        return wall === undefined
            ? `${formatFractionalInches(defaultWallHeight(params.value.od))} (default)`
            : formatFractionalInches(wall);
    }

    /** The cap the values describe now, or why they do not describe one. */
    resolve(): Result<EndCapParams> {
        return resolveEndCapValues(this.values, this.document.variables.evaluate().scope);
    }

    /** The configuration problem, if the last regeneration could not draw a cap. */
    get error(): string | undefined {
        return this._error;
    }

    override get warningCount(): number {
        return super.warningCount + (this._error === undefined ? 0 : 1);
    }

    override get warningTooltip(): I18nKeys {
        return this._error === undefined ? super.warningTooltip : "endCap.invalid";
    }

    /** Configuration switches and variable edits re-derive the cap before the sketch re-solves. */
    override applyVariables(): void {
        if (!this.editingSession) this.regenerate(false);
        super.applyVariables();
    }

    private setValue(
        key: "endcap" | "outerDiameter" | "innerDiameter" | "wallHeight",
        value: ParameterValue,
    ): void {
        // A recorded edit (undo assigns back through this setter, regenerating again).
        this.setProperty(key, value);
        this.regenerate(true);
    }

    /**
     * Redraws the sketch when the resolved cap differs from the one it shows. Derived state:
     * written outside the undo history (the causing edit — a value, a configuration switch — is
     * what history records, and re-deriving from it restores this).
     */
    private regenerate(emitShape: boolean): void {
        const params = this.resolve();
        if (!params.isOk) {
            this.reportError(params.error);
            return;
        }
        const sketch = endCapSketchData(params.value);
        if (!sketch.isOk) {
            this.reportError(sketch.error);
            return;
        }
        this.reportError(undefined);
        const signature = JSON.stringify(params.value);
        if (signature === this.generatedFor) return;
        this.refreshLabels();
        this.outsideHistory(() => {
            this.setPrivateValue("generatedFor", signature);
            const data: SketchData = sketch.value.data;
            if (emitShape) this.setDataEmitShapeChanged(data);
            else this.setProperty("dataJson", JSON.stringify(data));
            this.updateDrawing(params.value);
        });
    }

    private updateDrawing(params: EndCapParams): void {
        const id = this.drawingId;
        if (id === undefined) return;
        const drawing = this.document.modelManager.findNode((node) => node.id === id);
        if (!(drawing instanceof DocumentFileNode)) return;
        const file = endCapDxf(params);
        if (!file.isOk) return;
        drawing.fileName = file.value.name;
        drawing.content = file.value.text;
    }

    /** The read-only labels are derived: tell the properties panel they changed. */
    private refreshLabels(): void {
        for (const label of [
            "size",
            "outerDiameterLabel",
            "innerDiameterLabel",
            "wallHeightLabel",
        ] as const) {
            this.emitPropertyChanged(label, "");
        }
    }

    private reportError(error: string | undefined): void {
        if (error === this._error) return;
        const before = this.warningCount;
        this._error = error;
        this.emitPropertyChanged("warningCount", before);
        this.refreshLabels();
        if (error !== undefined) PubSub.default.pub("displayError", `End Cap: ${error}`);
    }

    private outsideHistory(action: () => void): void {
        const history = this.document.history;
        const disabled = history.disabled;
        history.disabled = true;
        try {
            action();
        } finally {
            history.disabled = disabled;
        }
    }
}
