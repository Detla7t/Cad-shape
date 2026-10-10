// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    GeometryNode,
    type IDocument,
    type INode,
    isFeatureListNode,
    type OperationEvent,
    OperationLog,
    Serializer,
    ShapeNode,
    ShapeTypes,
} from "@chili3d/core";
import { action, panelBody, table, textElement } from "./helpers";
import style from "./review.module.css";

/** One row of Onshape's "Regeneration times" list: a feature and its last rebuild. */
interface RegenerationRow {
    readonly order: number;
    readonly name: string;
    readonly ms: number;
    readonly outcome: string;
    readonly runs: number;
}

/** The rebuild events, one per feature (its latest), named through the document's feature lists. */
export function regenerationTimes(doc: IDocument, events: readonly OperationEvent[]): RegenerationRow[] {
    const names = new Map<string, { name: string; order: number }>();
    let order = 0;
    for (const node of doc.modelManager.findNodes()) {
        order++;
        if (node instanceof GeometryNode) names.set(node.id, { name: node.name, order });
        if (isFeatureListNode(node)) {
            for (const feature of node.featureItems()) {
                order++;
                names.set(feature.id, { name: `${node.name} › ${feature.name ?? feature.display}`, order });
            }
        }
    }
    const latest = new Map<string, RegenerationRow>();
    for (const event of events) {
        const featureId = String(event.context["featureId"] ?? "");
        if (!featureId) continue;
        const known = names.get(featureId);
        const previous = latest.get(featureId);
        latest.set(featureId, {
            order: known?.order ?? Number.MAX_SAFE_INTEGER,
            name: known?.name ?? featureId,
            ms: event.durationMs,
            outcome: event.outcome,
            runs: (previous?.runs ?? 0) + 1,
        });
    }
    return [...latest.values()].sort((a, b) => b.ms - a.ms);
}

/** What a node costs to draw and to store. */
interface ResourceRow {
    readonly name: string;
    readonly triangles: number;
    readonly segments: number;
    readonly points: number;
    readonly faces: number;
    readonly edges: number;
    readonly storedBytes: number;
}

export function resourceRows(doc: IDocument): ResourceRow[] {
    const rows: ResourceRow[] = [];
    for (const node of doc.modelManager.findNodes()) {
        if (!(node instanceof GeometryNode)) continue;
        let triangles = 0,
            segments = 0,
            points = 0,
            faces = 0,
            edges = 0;
        try {
            const mesh = node.mesh;
            triangles = Math.round((mesh.faces?.index?.length ?? 0) / 3);
            segments = Math.round((mesh.edges?.position?.length ?? 0) / 6);
            points = Math.round((mesh.vertexs?.position?.length ?? 0) / 3);
        } catch {
            // A node whose mesh is unavailable still lists its storage.
        }
        if (node instanceof ShapeNode && node.shape.isOk) {
            faces = node.shape.value.findSubShapes(ShapeTypes.face).length;
            edges = node.shape.value.findSubShapes(ShapeTypes.edge).length;
        }
        rows.push({
            name: node.name,
            triangles,
            segments,
            points,
            faces,
            edges,
            storedBytes: storedSize(node),
        });
    }
    return rows.sort((a, b) => b.triangles + b.segments - (a.triangles + a.segments));
}

/** The node's serialized size, as its document stores it. */
function storedSize(node: INode): number {
    try {
        return JSON.stringify(Serializer.serializeObject(node)).length;
    } catch {
        // A node that does not serialize on its own: count its stored strings.
    }
    const own = node as unknown as Record<string, unknown>;
    let size = 0;
    for (const key of ["dataJson", "featuresJson", "definitionJson", "content", "source"])
        if (typeof own[key] === "string") size += (own[key] as string).length;
    return size;
}

const format = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const bytes = (n: number) =>
    n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

/**
 * Onshape's Performance panel and more: the regeneration time of every feature (latest
 * rebuild, slowest first, with the total), what each model item costs to draw and store,
 * the viewport's frame rate against its quality profile, memory, and the recent
 * operations.
 */
export class PerformancePanel {
    readonly element: HTMLElement;
    private readonly timer: ReturnType<typeof setInterval>;
    constructor(doc: IDocument) {
        const { root, body } = panelBody("Performance");
        this.element = root;
        const output = document.createElement("div");
        const render = () => {
            const events = OperationLog.snapshot().filter((e) => e.context["documentId"] === doc.id);
            const view =
                doc.application.activeView?.document === doc ? doc.application.activeView : undefined;
            const stats = view?.renderStats?.() ?? {};
            const quality = view?.qualityState?.();
            const nodes = doc.modelManager.findNodes();
            const regen = regenerationTimes(
                doc,
                events.filter((e) => e.operation === "feature.rebuild"),
            );
            const totalRegen = regen.reduce((sum, row) => sum + row.ms, 0);
            const memory = (performance as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })
                .memory;
            const overview = [
                ["Metric", "Current value"],
                ["Model items", String(nodes.length)],
                [
                    "Features",
                    String(
                        nodes.reduce(
                            (n, node) => n + (isFeatureListNode(node) ? node.featureItems().length : 0),
                            0,
                        ),
                    ),
                ],
                ["Total regeneration time", `${totalRegen.toFixed(1)} ms`],
                ["Viewports", String(doc.application.views.filter((v) => v.document === doc).length)],
                ...(quality
                    ? [
                          [
                              "Rendering quality",
                              `${quality.profile} · target ${quality.targetFps} fps · level ${quality.movingLevel} · scale ${quality.renderScale}`,
                          ],
                          [
                              "Moving frame rate",
                              quality.movingFps === undefined
                                  ? "no motion yet"
                                  : `${quality.movingFps.toFixed(1)} fps`,
                          ],
                      ]
                    : []),
                ...Object.entries(stats)
                    .filter(([key]) => !/frame rate|Quality level|Render scale/.test(key))
                    .map(([key, value]) => [key, String(value)]),
                ...(memory
                    ? [
                          [
                              "JavaScript heap",
                              `${bytes(memory.usedJSHeapSize)} of ${bytes(memory.jsHeapSizeLimit)}`,
                          ],
                      ]
                    : []),
                ["Undo steps", String(doc.history.undoCount?.() ?? "")],
                ["Recorded operations", String(events.length)],
                ["Errors", String(events.filter((e) => e.outcome === "error").length)],
            ];
            const resources = resourceRows(doc);
            output.replaceChildren(
                table(overview),
                textElement("h4", "Regeneration times", style.sectionTitle),
                textElement(
                    "p",
                    regen.length
                        ? `Latest rebuild of each feature, slowest first. Total ${totalRegen.toFixed(1)} ms over ${regen.length} features.`
                        : "No feature has been rebuilt in this session yet.",
                    style.muted,
                ),
                ...(regen.length
                    ? [
                          table([
                              ["#", "Feature name", "Time", "Runs", "Outcome"],
                              ...regen.map((row) => [
                                  row.order === Number.MAX_SAFE_INTEGER ? "–" : String(row.order),
                                  row.name,
                                  `${row.ms.toFixed(1)} ms`,
                                  String(row.runs),
                                  row.outcome,
                              ]),
                          ]),
                      ]
                    : []),
                textElement("h4", "Resources by item", style.sectionTitle),
                textElement(
                    "p",
                    "What each item costs to draw (triangles, line segments, points), its topology (faces, edges) and what it takes to store.",
                    style.muted,
                ),
                table([
                    ["Item", "Triangles", "Segments", "Points", "Faces", "Edges", "Stored"],
                    ...resources.map((row) => [
                        row.name,
                        format(row.triangles),
                        format(row.segments),
                        format(row.points),
                        format(row.faces),
                        format(row.edges),
                        bytes(row.storedBytes),
                    ]),
                ]),
                textElement("h4", "Recent operations", style.sectionTitle),
                textElement(
                    "p",
                    "Command duration includes user input time; feature rebuild duration measures computation.",
                    style.muted,
                ),
                table([
                    ["#", "Operation", "Duration", "Outcome", "Detail"],
                    ...events
                        .slice(-25)
                        .reverse()
                        .map((e) => [
                            String(e.sequence),
                            `${e.operation}${e.context["featureId"] ? ` · ${e.context["featureId"]}` : ""}${e.context["command"] ? ` · ${e.context["command"]}` : ""}`,
                            `${e.durationMs.toFixed(2)} ms`,
                            e.outcome,
                            e.error?.message ?? String(e.context["action"] ?? e.context["records"] ?? ""),
                        ]),
                ]),
            );
        };
        body.append(action("Refresh", render), output);
        render();
        this.timer = setInterval(render, 2000);
    }
    dispose() {
        clearInterval(this.timer);
    }
}
