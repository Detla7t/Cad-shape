// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AutomationClient } from "@chili3d/ai";
import { Config } from "@chili3d/core";
import { createMockApplication } from "@chili3d/core/test-utils";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AutomationIndicator } from "../src/automation/automationIndicator";
import { AutomationSession, readUrlFlag } from "../src/automation/automationSession";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** An EventSource that never connects: the client stays "connecting" until a test says hello. */
class SilentSource {
    onerror: ((event: Event) => void) | null = null;
    readonly listeners = new Map<string, (event: MessageEvent) => void>();
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener);
    }
    close() {}
}

describe("readUrlFlag", () => {
    test.each([
        ["", { enabled: false }],
        ["?automation=1", { enabled: true }],
        ["?template=x&automation=true", { enabled: true }],
        ["?automation=0", { enabled: false }],
        ["?automation=7790", { enabled: true, port: 7790 }],
    ])("%s → %o", (search, expected) => {
        expect(readUrlFlag(search)).toEqual(expected);
    });
});

describe("AutomationIndicator", () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        host = document.createElement("div");
        document.body.append(host);
        root = createRoot(host);
    });

    afterEach(() => {
        act(() => root.unmount());
        host.remove();
    });

    test("shows only while connected, names the last tool, and Disconnect calls back", async () => {
        const source = new SilentSource();
        const client = new AutomationClient({
            sessionId: "tab-ui",
            tools: () => [],
            eventSource: () => source,
            fetch: (async () => new Response("{}")) as typeof fetch,
        });
        let disconnected = 0;
        act(() => root.render(<AutomationIndicator client={client} onDisconnect={() => disconnected++} />));
        act(() => client.start());
        expect(host.textContent).toBe("");

        await act(async () => {
            source.listeners.get("hello")!(new MessageEvent("hello", { data: JSON.stringify({ key: "k" }) }));
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(host.querySelector("[role=status]")?.textContent).toContain("Automation connected");

        await act(async () => {
            source.listeners.get("call")!(
                new MessageEvent("call", {
                    data: JSON.stringify({ id: "c1", tool: "missing_tool", args: {} }),
                }),
            );
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(host.textContent).toContain("missing_tool");

        const button = host.querySelector("button");
        expect(button).not.toBeNull();
        act(() => button!.click());
        expect(disconnected).toBe(1);
        act(() => client.stop());
        expect(host.textContent).toBe("");
    });
});

describe("AutomationSession", () => {
    const saved = Config.instance.preferences;

    afterEach(() => {
        Config.instance.preferences = saved;
        document.body.querySelectorAll("[data-automation-indicator]").forEach((element) => element.remove());
    });

    test("stays off unless the preference or the URL flag enables it, and Disconnect turns it off", () => {
        const session = new AutomationSession();
        Config.instance.preferences = {
            ...saved,
            automation: { enabled: false, bridgeUrl: "http://127.0.0.1:1" },
        };
        session.install(createMockApplication(), "");
        expect(session.activeClient).toBeUndefined();

        const flagged = new AutomationSession();
        flagged.install(createMockApplication(), "?automation=1");
        expect(flagged.activeClient?.url).toBe("http://127.0.0.1:1");
        expect(flagged.activeClient?.isRunning).toBe(true);
        expect(document.body.querySelector("[data-automation-indicator]")).not.toBeNull();

        flagged.disconnect();
        expect(flagged.activeClient).toBeUndefined();
        expect(document.body.querySelector("[data-automation-indicator]")).toBeNull();
    });
});
