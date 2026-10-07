// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDisposable, type IDocument, Logger, type NodeRecord, PubSub } from "@chili3d/core";
import { type DataSourceNode, dataSourcesOf, isDataSourceNode } from "./dataSourceNode";
import { isRemoteKind, refreshIntervalMs } from "./model/definition";

/**
 * Keeps remote sources fresh while their document is open: a source set to refresh "on open"
 * reads once the first time its document is shown this session, an "interval" source reads on
 * open and then every N seconds. Manual sources (and attached files, which do not change on
 * their own) are left alone. A read that finds the same tables writes nothing.
 */
export class DataRefreshScheduler implements IDisposable {
    private readonly timers = new Map<DataSourceNode, ReturnType<typeof setInterval>>();
    private readonly opened = new WeakSet<DataSourceNode>();
    private readonly documents = new Map<IDocument, (records: NodeRecord[]) => void>();
    private readonly watchedNodes = new Set<DataSourceNode>();

    /** Starts keeping `document`'s sources fresh (idempotent). */
    watch(document: IDocument): void {
        if (this.documents.has(document)) return;
        const observer = () => this.sync(document);
        this.documents.set(document, observer);
        document.modelManager.addNodeObserver(observer);
        this.sync(document);
    }

    unwatch(document: IDocument): void {
        const observer = this.documents.get(document);
        if (observer === undefined) return;
        this.documents.delete(document);
        document.modelManager?.removeNodeObserver(observer);
        for (const node of [...this.timers.keys()]) if (node.document === document) this.stop(node);
        for (const node of [...this.watchedNodes]) {
            if (node.document === document) {
                node.removePropertyChanged(this.handleNodeChanged);
                this.watchedNodes.delete(node);
            }
        }
    }

    /** Re-reads which sources `document` has and what each wants. */
    sync(document: IDocument): void {
        const sources = new Set(dataSourcesOf(document));
        for (const node of [...this.timers.keys()]) {
            if (node.document === document && !sources.has(node)) this.stop(node);
        }
        for (const node of sources) {
            if (!this.watchedNodes.has(node)) {
                this.watchedNodes.add(node);
                node.onPropertyChanged(this.handleNodeChanged);
            }
            this.schedule(node);
        }
    }

    private schedule(node: DataSourceNode): void {
        const definition = node.definition;
        const mode = isRemoteKind(definition.kind) ? (definition.refresh ?? "manual") : "manual";
        if (mode === "manual") {
            this.stop(node);
            return;
        }
        if (!this.opened.has(node)) {
            this.opened.add(node);
            this.read(node);
        }
        if (mode !== "interval") {
            this.stop(node);
            return;
        }
        this.stop(node);
        this.timers.set(
            node,
            setInterval(() => this.read(node), refreshIntervalMs(definition)),
        );
    }

    private read(node: DataSourceNode): void {
        node.refresh().catch((error) => Logger.warn(`data source "${node.name}": refresh failed`, error));
    }

    private stop(node: DataSourceNode): void {
        const timer = this.timers.get(node);
        if (timer === undefined) return;
        clearInterval(timer);
        this.timers.delete(node);
    }

    private readonly handleNodeChanged = (property: string | number | symbol, source: unknown) => {
        if (property === "definitionJson" && isDataSourceNode(source as DataSourceNode)) {
            this.schedule(source as DataSourceNode);
        }
    };

    dispose(): void {
        for (const document of [...this.documents.keys()]) this.unwatch(document);
        for (const node of [...this.timers.keys()]) this.stop(node);
    }
}

/**
 * Starts the application-wide scheduler: each document is watched once a view shows it and
 * released when it closes.
 */
export function startDataRefresh(): IDisposable {
    const scheduler = new DataRefreshScheduler();
    const onView = (view: { document?: IDocument } | undefined) => {
        if (view?.document !== undefined) scheduler.watch(view.document);
    };
    const onClosed = (document: IDocument) => scheduler.unwatch(document);
    PubSub.default.sub("activeViewChanged", onView);
    PubSub.default.sub("documentClosed", onClosed);
    return {
        dispose: () => {
            PubSub.default.remove("activeViewChanged", onView);
            PubSub.default.remove("documentClosed", onClosed);
            scheduler.dispose();
        },
    };
}
