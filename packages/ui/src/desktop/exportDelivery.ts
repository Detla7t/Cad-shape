// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    canOpenOnDesktop,
    type DesktopBridgeInfo,
    type DesktopOpened,
    type DesktopTarget,
    type DownloadedFile,
    desktopAppsFor,
    I18n,
    openOnDesktop,
    probeDesktopBridge,
    revealOnDesktop,
    setDownloadDelivery,
} from "@chili3d/core";
import { Toast, type ToastAction } from "../toast";

const PROBE_TTL_MS = 15_000;
const PROBE_TIMEOUT_MS = 1_500;
const MAX_APP_ACTIONS = 3;

/**
 * Where every `download()` goes once the main window runs. With the "open exports on the
 * desktop" preference on and the local desktop bridge running, the file is saved and opened
 * over there instead of downloaded. Otherwise the browser downloads it and a toast offers to
 * open it in the default program or in the CAD apps the bridge found, and to share it where the
 * browser can share files.
 */
export class ExportDelivery {
    private probe?: { url: string; at: number; info: DesktopBridgeInfo | undefined };
    private pending?: Promise<DesktopBridgeInfo | undefined>;

    /** Routes `download()` through this delivery; returns the uninstall. */
    install(): () => void {
        setDownloadDelivery(this.deliver);
        return () => setDownloadDelivery(undefined);
    }

    /** Forgets the last probe (the preferences changed, the user started the bridge). */
    refresh() {
        this.probe = undefined;
    }

    /** What the bridge at the preferred URL offers; undefined when it is not running. Cached briefly. */
    bridge(): Promise<DesktopBridgeInfo | undefined> {
        const url = Config.instance.preferences.desktop.bridgeUrl;
        if (this.probe && this.probe.url === url && Date.now() - this.probe.at < PROBE_TTL_MS) {
            return Promise.resolve(this.probe.info);
        }
        if (!this.pending) {
            this.pending = probeDesktopBridge(url, { timeoutMs: PROBE_TIMEOUT_MS }).then((result) => {
                this.probe = { url, at: Date.now(), info: result.isOk ? result.value : undefined };
                this.pending = undefined;
                return this.probe.info;
            });
        }
        return this.pending;
    }

    /** The `DownloadDelivery`: true when the bridge took the file. */
    readonly deliver = async (file: DownloadedFile): Promise<boolean> => {
        const preferences = Config.instance.preferences.desktop;
        const info = await this.bridge();
        const bridge = info !== undefined && canOpenOnDesktop(info, file.name) ? info : undefined;
        if (preferences.openExports && bridge) {
            const opened = await openOnDesktop(bridge.url, file, "default");
            if (opened.isOk) {
                this.showOpened(bridge, file.name, opened.value);
                return true;
            }
            Toast.error(I18n.translate("toast.export.openFailed{0}", opened.error));
            return false;
        }
        this.showDownloaded(file, bridge);
        return false;
    };

    private showDownloaded(file: DownloadedFile, bridge: DesktopBridgeInfo | undefined) {
        const actions: ToastAction[] = [];
        if (bridge) {
            actions.push({
                label: I18n.translate("export.openInDefaultApp"),
                run: () => this.open(bridge, file, "default"),
            });
            for (const app of desktopAppsFor(bridge, file.name).slice(0, MAX_APP_ACTIONS)) {
                actions.push({
                    label: I18n.translate("export.openIn{0}", app.name),
                    run: () => this.open(bridge, file, app.id),
                });
            }
        }
        const share = shareAction(file);
        if (share) actions.push(share);
        if (actions.length === 0) return;
        Toast.show({ message: I18n.translate("toast.export.downloaded{0}", file.name), actions });
    }

    private async open(bridge: DesktopBridgeInfo, file: DownloadedFile, target: DesktopTarget) {
        const opened = await openOnDesktop(bridge.url, file, target);
        if (!opened.isOk) {
            Toast.error(I18n.translate("toast.export.openFailed{0}", opened.error));
            return;
        }
        this.showOpened(bridge, file.name, opened.value);
    }

    private showOpened(bridge: DesktopBridgeInfo, name: string, opened: DesktopOpened) {
        const app = opened.app.id === "default" ? I18n.translate("export.defaultApp") : opened.app.name;
        Toast.show({
            message: I18n.translate("toast.export.openedIn{0}{1}", name, app),
            actions: [
                {
                    label: I18n.translate("export.showInFolder"),
                    run: async () => {
                        const revealed = await revealOnDesktop(bridge.url, opened.path);
                        if (!revealed.isOk) Toast.error(revealed.error);
                    },
                },
            ],
        });
    }
}

/** "Share…" through the Web Share API, where the browser can share files (Android, Windows, macOS). */
function shareAction(file: DownloadedFile): ToastAction | undefined {
    if (
        typeof navigator === "undefined" ||
        typeof navigator.share !== "function" ||
        typeof navigator.canShare !== "function"
    ) {
        return undefined;
    }
    const shared = new File([file.blob], file.name, { type: file.blob.type || "application/octet-stream" });
    try {
        if (!navigator.canShare({ files: [shared] })) return undefined;
    } catch {
        return undefined;
    }
    return {
        label: I18n.translate("export.share"),
        run: async () => {
            try {
                await navigator.share({ title: file.name, files: [shared] });
            } catch (error) {
                if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
            }
        },
    };
}

export const exportDelivery = new ExportDelivery();
