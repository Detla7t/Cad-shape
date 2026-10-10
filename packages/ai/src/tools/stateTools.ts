// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    DocumentElements,
    DocumentLibrary,
    type IApplication,
    type IDocument,
    type IShape,
    OperationLog,
    ShapeTypes,
    type VisualShapeData,
} from "@chili3d/core";
import type { Tool, ToolResult } from "../llm/types";
import { DRIVE_APP_GROUP } from "./automationGroup";
import { commandState } from "./commandTools";
import { getApplication } from "./documentContext";

/**
 * What a remote client needs to verify an action: the open documents and views, the active
 * element tab, the selection with its sub-shapes, the undo and redo stacks, the running
 * command, and the OperationLog's latest events.
 */

const text = (value: unknown): ToolResult => ({ content: JSON.stringify(value) });

function shapeTypeName(shape: IShape): string {
    return (
        Object.keys(ShapeTypes).find(
            (key) => ShapeTypes[key as keyof typeof ShapeTypes] === shape.shapeType,
        ) ?? String(shape.shapeType)
    );
}

function summarizeShape(data: VisualShapeData) {
    return {
        nodeId: data.owner?.node?.id,
        shapeType: shapeTypeName(data.shape),
        index: (data.shape as { index?: number }).index ?? data.indexes?.[0],
    };
}

/** The document's element tabs (Part Studio first) and which one shows, read from the tab strip. */
function elementsOf(document: IDocument) {
    const active = globalThis.document
        ?.querySelector?.("[data-element-id][class*='active']")
        ?.getAttribute("data-element-id");
    const elements = [
        { id: "partStudio", kind: "partStudio", name: "Part Studio" },
        ...DocumentElements.elementsOf(document).map(({ kind, node }) => ({
            id: node.id,
            kind: kind.kind,
            name: node.name,
        })),
    ];
    return { elements, active: active ?? undefined };
}

function documentState(app: IApplication, document: IDocument) {
    const active = app.activeView?.document === document;
    return {
        id: document.id,
        name: document.name,
        active,
        nodeCount: document.modelManager?.findNodes?.().length,
        views: app.views.filter((view) => view.document === document).map((view) => view.name),
    };
}

export function appState(app: IApplication) {
    const view = app.activeView;
    const document = view?.document;
    const history = document?.history;
    return {
        documents: [...app.documents].map((d) => documentState(app, d)),
        activeView: view
            ? {
                  name: view.name,
                  document: document?.id,
                  mode: view.mode,
                  width: view.width,
                  height: view.height,
              }
            : undefined,
        workspace: document ? elementsOf(document) : undefined,
        selection: document
            ? {
                  nodes: document.selection.getSelectedNodes().map((node) => ({
                      id: node.id,
                      name: node.name,
                      type: node.constructor.name,
                  })),
                  shapes: document.selection.getSelectedShapes().map(summarizeShape),
              }
            : undefined,
        history: history
            ? {
                  undo: history.undoNames?.().slice(-15) ?? [],
                  redo: history.redoNames?.().slice(-15) ?? [],
                  undoCount: history.undoCount(),
                  redoCount: history.redoCount(),
              }
            : undefined,
        command: commandState(app),
    };
}

function appStateTool(): Tool {
    return {
        name: "get_app_state",
        description:
            "Read the application state: open documents (which is active), the active view, the active document's element tabs (Part Studio, Feature/Variable/CAM Studios, drawings…) and which one shows, the selected nodes and sub-shapes, the undo/redo stacks (step names, the next undo last) and the running command with its prompt.",
        parameters: { type: "object", properties: {} },
        indexGroup: DRIVE_APP_GROUP,
        handler: async () => {
            const app = getApplication();
            if (!app) return text({ error: "no application" });
            return text(appState(app));
        },
    };
}

function listDocumentsTool(): Tool {
    return {
        name: "list_documents",
        description:
            "List the open documents and the saved ones in this browser's library (id, name, last saved).",
        parameters: {
            type: "object",
            properties: {
                limit: { type: "number", description: "Most saved documents to list (default 50)" },
            },
        },
        indexGroup: DRIVE_APP_GROUP,
        handler: async (args) => {
            const app = getApplication();
            if (!app) return text({ error: "no application" });
            const open = [...app.documents].map((d) => documentState(app, d));
            let saved: { id: string; name: string; date?: number; trashed?: boolean }[] = [];
            try {
                const library = await new DocumentLibrary(app.storage).list();
                saved = library.documents
                    .map((d) => ({
                        id: d.id,
                        name: d.name,
                        date: d.date,
                        trashed: d.metadata.trashedAt !== undefined || undefined,
                    }))
                    .sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
                    .slice(0, Math.max(1, Number(args["limit"]) || 50));
            } catch (error) {
                return text({ open, savedError: error instanceof Error ? error.message : String(error) });
            }
            return text({ open, saved });
        },
    };
}

function activateDocumentTool(): Tool {
    return {
        name: "activate_document",
        description:
            "Make a document the active one: switches to it when it is open, or opens it from the library by id (see list_documents).",
        parameters: {
            type: "object",
            properties: { id: { type: "string", description: "Document id" } },
            required: ["id"],
        },
        indexGroup: DRIVE_APP_GROUP,
        handler: async (args) => {
            const app = getApplication();
            if (!app) return text({ error: "no application" });
            const id = String(args["id"] ?? "");
            const view = app.views.find((v) => v.document.id === id);
            if (view) {
                app.activeView = view;
                return text({ ok: true, opened: false, document: documentState(app, view.document) });
            }
            const document = await app.openDocument(id);
            if (!document) return text({ error: `no document ${id} in the library` });
            return text({ ok: true, opened: true, document: documentState(app, document) });
        },
    };
}

function openElementTool(): Tool {
    return {
        name: "open_element",
        description:
            'Show an element tab of the active document: "partStudio", or an element node id (Feature Studio, Variable Studio, CAM Studio, drawing, attached file…) from get_app_state.',
        parameters: {
            type: "object",
            properties: { id: { type: "string", description: '"partStudio" or the element node id' } },
            required: ["id"],
        },
        indexGroup: DRIVE_APP_GROUP,
        handler: async (args) => {
            const document = getApplication()?.activeView?.document;
            if (!document) return text({ error: "no active document" });
            const id = String(args["id"] ?? "");
            if (id === "partStudio") {
                DocumentElements.showPartStudio(document);
                return text({ ok: true, shown: "partStudio" });
            }
            const element = DocumentElements.elementsOf(document).find(({ node }) => node.id === id);
            if (!element) {
                return text({
                    error: `no element ${id} in this document`,
                    elements: elementsOf(document).elements,
                });
            }
            DocumentElements.open(document, element.node);
            return text({ ok: true, shown: { id, kind: element.kind.kind, name: element.node.name } });
        },
    };
}

function operationLogTool(): Tool {
    return {
        name: "get_operation_log",
        description:
            "Read the latest OperationLog events (one per command, transaction, feature rebuild, sketch commit, error, automation call): operation, outcome, duration, context, steps and error. Filter by operation prefix, outcome, or afterSequence (the sequence of an event seen before) to see only what an action caused.",
        parameters: {
            type: "object",
            properties: {
                limit: { type: "number", description: "Most recent events to return (default 20)" },
                operation: {
                    type: "string",
                    description: 'Operation name prefix, e.g. "command." or "feature.rebuild"',
                },
                outcome: { type: "string", enum: ["success", "cancelled", "error", "rolled_back"] },
                afterSequence: { type: "number", description: "Only events with a larger sequence number" },
                includeState: {
                    type: "boolean",
                    description: "Include each event's application state block",
                },
            },
        },
        indexGroup: DRIVE_APP_GROUP,
        handler: async (args) => {
            const limit = Math.max(1, Math.min(500, Number(args["limit"]) || 20));
            const prefix = typeof args["operation"] === "string" ? args["operation"] : undefined;
            const after = Number(args["afterSequence"] ?? 0) || 0;
            const events = OperationLog.snapshot()
                .filter((event) => event.sequence > after)
                .filter((event) => prefix === undefined || event.operation.startsWith(prefix))
                .filter((event) => args["outcome"] === undefined || event.outcome === args["outcome"])
                .slice(-limit)
                .map((event) => ({
                    sequence: event.sequence,
                    operation: event.operation,
                    outcome: event.outcome,
                    timestamp: event.timestamp,
                    durationMs: event.durationMs,
                    ...(event.parentId ? { parentId: event.parentId } : {}),
                    operationId: event.operationId,
                    context: event.context,
                    ...(args["includeState"] === true ? { state: event.state } : {}),
                    ...(event.steps ? { steps: event.steps } : {}),
                    ...(event.error
                        ? { error: { name: event.error.name, message: event.error.message } }
                        : {}),
                }));
            return text({
                events,
                latestSequence: OperationLog.snapshot().at(-1)?.sequence ?? 0,
                openOperations: OperationLog.openOperations(),
            });
        },
    };
}

export function buildStateTools(): Tool[] {
    return [
        appStateTool(),
        listDocumentsTool(),
        activateDocumentTool(),
        openElementTool(),
        operationLogTool(),
    ];
}
