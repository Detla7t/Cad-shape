// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AutomationClient, buildTools } from "@chili3d/ai";
import { Config, type IApplication, PubSub } from "@chili3d/core";
import { mountIsland, type ReactIsland } from "@chili3d/react";
import { createElement } from "react";
import { AutomationIndicator } from "./automationIndicator";

/**
 * Connects this tab to the local automation bridge while the user wants it: the Automation
 * preference, or `?automation=1` in the address for this session only (`?automation=<port>`
 * also picks the port). Shows the indicator while connected; its Disconnect ends the
 * connection until the page reloads or the preference is saved again.
 */
export class AutomationSession {
    private app?: IApplication;
    private client?: AutomationClient;
    private island?: ReactIsland;
    private host?: HTMLElement;
    private urlFlag: { enabled: boolean; port?: number } = { enabled: false };
    private dismissed = false;

    get state() {
        return this.client?.state ?? "off";
    }

    get activeClient(): AutomationClient | undefined {
        return this.client;
    }

    install(app: IApplication, search = globalThis.location?.search ?? "") {
        this.app = app;
        this.urlFlag = readUrlFlag(search);
        PubSub.default.sub("activeViewChanged", () => void this.client?.refresh());
        this.update();
    }

    /** Applies saved preferences (the user saved them, so an earlier Disconnect no longer holds). */
    apply() {
        this.dismissed = false;
        this.update();
    }

    disconnect() {
        this.dismissed = true;
        this.update();
    }

    private bridgeUrl(): string {
        const url = Config.instance.preferences.automation.bridgeUrl.replace(/\/+$/, "");
        if (this.urlFlag.port === undefined) return url;
        const parsed = new URL(url);
        parsed.port = String(this.urlFlag.port);
        return parsed.toString().replace(/\/+$/, "");
    }

    private update() {
        if (!this.app) return;
        const wanted =
            !this.dismissed && (Config.instance.preferences.automation.enabled || this.urlFlag.enabled);
        const url = this.bridgeUrl();
        if (this.client && (!wanted || this.client.url !== url)) this.close();
        if (!wanted || this.client) return;
        const app = this.app;
        const client = new AutomationClient({
            url,
            tools: () => buildTools("automation"),
            info: () => ({
                url: globalThis.location?.href,
                title: globalThis.document?.title,
                documentName: app.activeView?.document.name,
                documentId: app.activeView?.document.id,
            }),
        });
        this.client = client;
        this.host = document.createElement("div");
        this.host.dataset["automationIndicator"] = "";
        document.body.append(this.host);
        this.island = mountIsland(
            this.host,
            createElement(AutomationIndicator, { client, onDisconnect: () => this.disconnect() }),
            app,
        );
        client.start();
    }

    private close() {
        this.client?.stop();
        this.client = undefined;
        this.island?.dispose();
        this.island = undefined;
        this.host?.remove();
        this.host = undefined;
    }
}

/** `?automation=1` (or true/on) enables it for this session; `?automation=7790` also sets the port. */
export function readUrlFlag(search: string): { enabled: boolean; port?: number } {
    const value = new URLSearchParams(search).get("automation");
    if (value === null) return { enabled: false };
    if (/^\d{2,5}$/.test(value)) return { enabled: true, port: Number(value) };
    return { enabled: ["", "1", "true", "on", "yes"].includes(value.toLowerCase()) };
}

export const automationSession = new AutomationSession();
