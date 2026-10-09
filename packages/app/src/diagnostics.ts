// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    CommandStore,
    Config,
    DocumentVersionControl,
    documentUnits,
    type IApplication,
    type ICommand,
    type IDisposable,
    type LogContext,
    OperationLog,
    PubSub,
} from "@chili3d/core";

/**
 * Wires the application into the operation log so every event carries what a bug report
 * needs: the build and platform (session), and at finish the document, its history head,
 * the selection, the view, the running command and the preferences that change behaviour
 * (state). User-facing errors and unhandled exceptions become events of their own, so a
 * log read back in sequence order shows what the user did, what the app was in, and what
 * went wrong.
 */
export function installDiagnostics(app: IApplication): IDisposable {
    OperationLog.setSessionContext({
        appVersion: __APP_VERSION__,
        documentFormat: __DOCUMENT_VERSION__,
        production: __IS_PRODUCTION__,
        userAgent: globalThis.navigator?.userAgent,
        language: globalThis.navigator?.language,
        platform: globalThis.navigator?.platform,
        devicePixelRatio: globalThis.devicePixelRatio,
        screen: globalThis.screen ? `${globalThis.screen.width}x${globalThis.screen.height}` : undefined,
        hardwareConcurrency: globalThis.navigator?.hardwareConcurrency,
    });

    const unregister = OperationLog.addContextProvider(() => applicationState(app));

    const onDisplayError = (message: string) =>
        OperationLog.record("ui.error", { message: String(message).slice(0, 500) }, "error");
    PubSub.default.sub("displayError", onDisplayError);

    const onError = (event: ErrorEvent) =>
        OperationLog.record(
            "app.unhandledError",
            { source: event.filename, line: event.lineno, column: event.colno },
            "error",
            event.error ?? event.message,
        );
    const onRejection = (event: PromiseRejectionEvent) =>
        OperationLog.record("app.unhandledRejection", {}, "error", event.reason);
    globalThis.addEventListener?.("error", onError);
    globalThis.addEventListener?.("unhandledrejection", onRejection);

    return {
        dispose() {
            unregister();
            PubSub.default.remove("displayError", onDisplayError);
            globalThis.removeEventListener?.("error", onError);
            globalThis.removeEventListener?.("unhandledrejection", onRejection);
        },
    };
}

/** The application as it stands right now: document, history, selection, view, command, preferences. */
export function applicationState(app: IApplication): LogContext {
    const view = app.activeView;
    const document = view?.document;
    const state: LogContext = {
        documents: app.documents.size,
        views: app.views.length,
        executingCommand: app.executingCommand === undefined ? undefined : commandName(app.executingCommand),
        navigation: Config.instance.navigation3D,
        snap: Config.instance.enableSnap,
        autosave: Config.instance.preferences.autosave,
        pixelDensity: Config.instance.preferences.pixelDensity,
    };
    if (view !== undefined) {
        Object.assign(state, {
            viewName: view.name,
            cameraType: view.cameraController.cameraType,
            viewMode: view.mode,
            viewSize: `${view.width}x${view.height}`,
        });
    }
    if (document !== undefined) {
        const units = documentUnits(document);
        const control = DocumentVersionControl.of(document);
        Object.assign(state, {
            documentId: document.id,
            documentName: document.name,
            lengthUnit: units.length,
            angleUnit: units.angle,
            nodes: document.modelManager.findNodes().length,
            selectedNodes: document.selection.getSelectedNodes().length,
            selectedShapes: document.selection.getSelectedShapes().length,
            undoDepth: document.history.undoCount(),
            redoDepth: document.history.redoCount(),
            branch: control?.currentBranch,
            head: control?.head,
            pendingOperations: control?.pendingOperations().length,
        });
    }
    return state;
}

/** The registered key of a running command, falling back to its class name. */
function commandName(command: ICommand): string {
    return CommandStore.getComandData(command)?.key ?? command.constructor.name;
}
