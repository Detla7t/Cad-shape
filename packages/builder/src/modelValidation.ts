// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ActiveConfigurationData,
    type ConfigurationData,
    GeometryNode,
    type IDocument,
    type INode,
    type IShape,
    type Serialized,
    ShapeNode,
    ShapeTypes,
} from "@chili3d/core";

export interface ModelValidationIssue {
    readonly severity: "error" | "warning";
    readonly code: string;
    readonly message: string;
    readonly nodeId?: string;
    readonly itemId?: string;
}

export interface RebuiltShapeSummary {
    readonly nodeId: string;
    readonly volume: number;
    readonly faces: number;
    readonly edges: number;
}

export interface ModelValidationCase {
    readonly configuration: ActiveConfigurationData;
    readonly issues: readonly ModelValidationIssue[];
    readonly shapes: readonly RebuiltShapeSummary[];
    readonly roundTripChecked: boolean;
}

export interface ModelValidationReport {
    /** Passed means the reported cases rebuilt, not a proof over continuous parameter ranges. */
    readonly status: "passed" | "failed" | "incomplete";
    readonly coverage: "discrete" | "sampled" | "explicit";
    readonly cases: readonly ModelValidationCase[];
    readonly issues: readonly ModelValidationIssue[];
    readonly sourceChanged: boolean;
}

export interface ModelValidationOptions {
    /** Extra explicit cases instead of automatic enumeration. The current state is always checked. */
    readonly configurations?: readonly ActiveConfigurationData[];
    /** A cap is reported as incomplete, never silently counted as exhaustive. Default 64. */
    readonly maxCases?: number;
    readonly signal?: AbortSignal;
}

/**
 * Rebuilds CAD/sketch/assembly definitions in isolated documents with empty shape caches,
 * then serializes and rebuilds each successful case again. Never edits the open document,
 * its history, selection or active configuration, and never saves or posts output.
 * CAM, document-format fidelity and externally cached link source definitions require
 * their own qualification; this report covers local modeling and constraint solving.
 */
export async function validateModel(
    document: IDocument,
    options: ModelValidationOptions = {},
): Promise<ModelValidationReport> {
    const maxCases = options.maxCases ?? 64;
    if (!Number.isSafeInteger(maxCases) || maxCases < 1)
        throw new Error("maxCases must be a positive safe integer");
    const snapshot = structuredClone(document.serialize());
    const sourceKey = JSON.stringify(snapshot);
    const plan = configurationCases(snapshot["configuration"], options.configurations, maxCases);
    const issues: ModelValidationIssue[] = [];
    const cases: ModelValidationCase[] = [];
    const { DetachedDocument } = await import("@chili3d/assembly");
    let incomplete = plan.truncated;
    if (plan.truncated)
        issues.push({
            severity: "warning",
            code: "case-limit",
            message: `Validation reached its ${maxCases}-case limit.`,
        });
    for (const configuration of plan.cases) {
        // Let cancellation and edits be observed between expensive native rebuilds.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (options.signal?.aborted) {
            incomplete = true;
            issues.push({
                severity: "warning",
                code: "cancelled",
                message: "Model validation was cancelled.",
            });
            break;
        }
        const caseIssues: ModelValidationIssue[] = [];
        let shapes: RebuiltShapeSummary[] = [];
        let roundTripChecked = false;
        let detached: InstanceType<typeof DetachedDocument> | undefined;
        try {
            const data = structuredClone(snapshot);
            data["configuration"] = { inputs: data["configuration"]?.inputs ?? [], active: configuration };
            detached = await DetachedDocument.load(document.application, data);
            shapes = await inspectRebuild(detached, caseIssues);
            if (!caseIssues.some((issue) => issue.severity === "error")) {
                const saved = structuredClone(detached.serialize());
                detached.dispose();
                detached = undefined;
                detached = await DetachedDocument.load(document.application, saved);
                const restored = await inspectRebuild(detached, caseIssues);
                roundTripChecked = true;
                if (!sameGeometry(shapes, restored))
                    caseIssues.push({
                        severity: "error",
                        code: "round-trip",
                        message: "Geometry changed after saving and rebuilding the validation copy.",
                    });
            }
        } catch (error) {
            caseIssues.push({ severity: "error", code: "rebuild", message: errorMessage(error) });
        } finally {
            detached?.dispose();
        }
        cases.push({ configuration, issues: deduplicate(caseIssues), shapes, roundTripChecked });
    }
    const sourceChanged = JSON.stringify(document.serialize()) !== sourceKey;
    if (sourceChanged) {
        incomplete = true;
        issues.push({
            severity: "warning",
            code: "source-changed",
            message: "The open model changed during validation; the results describe the captured revision.",
        });
    }
    if (
        cases.some((item) =>
            item.issues.some((issue) => ["external-source", "unsupported-geometry"].includes(issue.code)),
        )
    )
        incomplete = true;
    const failed = cases.some((item) => item.issues.some((issue) => issue.severity === "error"));
    return {
        status: failed ? "failed" : incomplete ? "incomplete" : "passed",
        coverage: plan.coverage,
        cases,
        issues,
        sourceChanged,
    };
}

function configurationCases(
    data: ConfigurationData | undefined,
    explicit: readonly ActiveConfigurationData[] | undefined,
    limit: number,
): { cases: ActiveConfigurationData[]; truncated: boolean; coverage: ModelValidationReport["coverage"] } {
    const cases: ActiveConfigurationData[] = [];
    const keys = new Set<string>();
    let truncated = false;
    const add = (active: ActiveConfigurationData) => {
        const key = JSON.stringify(Object.entries(active).sort(([a], [b]) => a.localeCompare(b)));
        if (keys.has(key)) return;
        keys.add(key);
        if (cases.length === limit) truncated = true;
        else cases.push(active);
    };
    add(data?.active ?? {});
    if (explicit !== undefined) {
        for (const active of explicit) add({ ...data?.active, ...active });
        return { cases, truncated, coverage: "explicit" };
    }
    const inputs = data?.inputs ?? [];
    const visit = (index: number, active: ActiveConfigurationData) => {
        if (truncated) return;
        if (index === inputs.length) return add(active);
        const input = inputs[index];
        const values: (string | boolean)[] =
            input.kind === "list"
                ? input.options.map((option) => option.name)
                : input.kind === "checkbox"
                  ? [false, true]
                  : [
                        ...new Set([
                            input.defaultExpression,
                            ...[input.min, input.max].filter((n) => n !== undefined).map(String),
                        ]),
                    ];
        for (const value of values) visit(index + 1, { ...active, [input.name]: value });
    };
    visit(0, data?.active ?? {});
    return {
        cases,
        truncated,
        coverage: inputs.some((input) => input.kind === "variable") ? "sampled" : "discrete",
    };
}

async function inspectRebuild(
    document: IDocument,
    issues: ModelValidationIssue[],
): Promise<RebuiltShapeSummary[]> {
    const { SketchNode, SketchSolver, ParametricBodyNode, FeatureStudioNode, compileDocumentStudio } =
        await import("@chili3d/parametric");
    const { resolveFacePlane } = await import("@chili3d/parametric/src/sketch/planeRef");
    const { AssemblyNode, LinkedPartNode, evaluateAssembly, solveAssembly } = await import(
        "@chili3d/assembly"
    );
    const add = (
        node: INode,
        code: string,
        message: string,
        severity: "error" | "warning" = "error",
        itemId?: string,
    ) => issues.push({ severity, code, message, nodeId: node.id, itemId });
    const variables = document.variables.evaluate();
    for (const [itemId, message] of variables.errors)
        issues.push({ severity: "error", code: "variable", message, itemId });
    const nodes = document.modelManager.findNodes();
    // Stored sketch coordinates are a starting guess. Solve all constraints again
    // before accepting the downstream solids that those coordinates can produce.
    for (const node of nodes) {
        if (!(node instanceof SketchNode) || node.suppressed) continue;
        try {
            void node.shape; // resolve plane and external references in the fresh tree
            if (
                node.planeRef !== undefined &&
                resolveFacePlane(document, node.planeRef, node.data.refPositions) === undefined
            )
                add(node, "sketch-plane", "The sketch's support plane no longer resolves.");
            const data = node.data;
            for (const ref of data.externalRefs ?? []) {
                if (ref.dangling)
                    add(
                        node,
                        "sketch-reference",
                        "An external sketch reference no longer resolves.",
                        "error",
                        String(ref.entityId),
                    );
            }
            const solver = new SketchSolver(node.plane, data, variables.scope);
            try {
                const outcome = solver.solve(true);
                for (const [id, message] of solver.datumErrors)
                    add(node, "sketch-datum", message, "error", String(id));
                if (!outcome.result.startsWith("Ok")) add(node, "sketch-solve", outcome.result);
                else if (outcome.dofs > 0)
                    add(node, "sketch-dof", `${outcome.dofs} degrees of freedom remain.`, "warning");
                if (outcome.result.startsWith("Ok") && solver.datumErrors.size === 0)
                    node.setDataEmitShapeChanged({ ...data, ...solver.toData(), anchors: data.anchors });
            } finally {
                solver.dispose();
            }
        } catch (error) {
            add(node, "sketch-solve", errorMessage(error));
        }
    }
    const shapes: RebuiltShapeSummary[] = [];
    for (const node of nodes) {
        const nodeType = node.constructor.name;
        try {
            if (node instanceof LinkedPartNode) {
                add(
                    node,
                    "external-source",
                    "Linked source definitions are not independently rebuilt by local validation.",
                    "warning",
                );
                continue;
            }
            if (node instanceof FeatureStudioNode) {
                const compiled = compileDocumentStudio(document, node.id);
                if (compiled?.error !== undefined) add(node, "featurescript", compiled.error);
            }
            if (node instanceof ShapeNode) {
                const result = node.shape;
                if (node.evaluationError !== undefined) add(node, "shape-rebuild", node.evaluationError);
                if (!result.isOk) continue;
                if (!result.value.checkShape())
                    add(node, "shape-validity", "The kernel reports invalid topology.");
                const volume = result.value.volume();
                if (!Number.isFinite(volume)) add(node, "shape-volume", "The rebuilt volume is not finite.");
                shapes.push({
                    nodeId: node.id,
                    volume,
                    faces: countSubshapes(result.value, ShapeTypes.face),
                    edges: countSubshapes(result.value, ShapeTypes.edge),
                });
                if (node instanceof ParametricBodyNode) {
                    for (const feature of node.featureItems()) {
                        if (feature.error) add(node, "feature", feature.error, "error", feature.id);
                        if (feature.warning)
                            add(node, "feature-warning", feature.warning, "warning", feature.id);
                    }
                }
            }
            if (node instanceof AssemblyNode) {
                const evaluation = evaluateAssembly(document, node);
                for (const instance of evaluation.instances) {
                    if (instance.instance.source.kind === "link" && instance.status !== "suppressed")
                        add(
                            node,
                            "external-source",
                            "A linked assembly source needs independent validation.",
                            "warning",
                            instance.instance.id,
                        );
                    else if (instance.status !== "ok" && instance.status !== "suppressed")
                        add(
                            node,
                            "assembly-source",
                            instance.message ?? instance.status,
                            "error",
                            instance.instance.id,
                        );
                }
                const solved = solveAssembly(node, { apply: true });
                if (solved.status !== "solved")
                    add(node, "assembly-solve", `Conflicting mates: ${solved.failingMates.join(", ")}`);
                if (solved.dof > 0)
                    add(node, "assembly-dof", `${solved.dof} degrees of freedom remain.`, "warning");
                if (solved.overConstrained)
                    add(node, "assembly-redundant", "The assembly has redundant constraints.", "warning");
            }
            if (node instanceof GeometryNode && !(node instanceof ShapeNode))
                add(
                    node,
                    "unsupported-geometry",
                    `Independent validation is not implemented for ${nodeType}.`,
                    "warning",
                );
        } catch (error) {
            add(node, "node-rebuild", errorMessage(error));
        }
    }
    return shapes.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

function countSubshapes(shape: IShape, kind: typeof ShapeTypes.face | typeof ShapeTypes.edge): number {
    const children = shape.findSubShapes(kind);
    try {
        return children.length;
    } finally {
        for (const child of children) child.dispose();
    }
}

function sameGeometry(a: readonly RebuiltShapeSummary[], b: readonly RebuiltShapeSummary[]): boolean {
    return (
        a.length === b.length &&
        a.every((shape, index) => {
            const other = b[index];
            return (
                shape.nodeId === other.nodeId &&
                shape.faces === other.faces &&
                shape.edges === other.edges &&
                Math.abs(shape.volume - other.volume) <= Math.max(1e-6, Math.abs(shape.volume) * 1e-9)
            );
        })
    );
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
function deduplicate(issues: readonly ModelValidationIssue[]): ModelValidationIssue[] {
    return [...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()];
}
