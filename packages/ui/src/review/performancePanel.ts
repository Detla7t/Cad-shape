// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, isFeatureListNode, OperationLog } from "@chili3d/core";
import { action, panelBody, table, textElement } from "./helpers";
import style from "./review.module.css";

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
            const stats = view?.renderStats?.();
            const nodes = doc.modelManager.findNodes();
            const rows = [
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
                ["Viewports", String(doc.application.views.filter((v) => v.document === doc).length)],
                ...Object.entries(stats ?? {}).map(([key, value]) => [key, String(value)]),
                ["Recorded operations", String(events.length)],
                ["Errors", String(events.filter((e) => e.outcome === "error").length)],
            ];
            output.replaceChildren(
                table(rows),
                textElement(
                    "p",
                    "Last rendered frame and recent completed operations. Command duration includes user input time; feature rebuild duration measures computation.",
                    style.muted,
                ),
                table([
                    ["Operation", "Duration", "Outcome"],
                    ...events
                        .slice(-25)
                        .reverse()
                        .map((e) => [
                            `${e.operation}${e.context["featureId"] ? ` · ${e.context["featureId"]}` : ""}`,
                            `${e.durationMs.toFixed(2)} ms`,
                            e.outcome,
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
