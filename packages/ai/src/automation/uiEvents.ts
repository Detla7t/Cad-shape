// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys, PubSub } from "@chili3d/core";

/**
 * What the app last told the user on the bus: the status-bar prompt a running command shows
 * while it waits for a pick ("Select the first point"), and the latest toasts and errors. A
 * remote client reads it to know what the command it started is waiting for.
 */

export interface UiMessage {
    readonly seq: number;
    readonly kind: "toast" | "error";
    readonly text: string;
    readonly at: string;
}

const MAX_MESSAGES = 10;

let installed = false;
let statusTip: string | undefined;
let sequence = 0;
const messages: UiMessage[] = [];

const translate = (key: string, args: unknown[] = []) => {
    try {
        return I18n.translate(key as I18nKeys, ...args);
    } catch {
        return key;
    }
};

const remember = (kind: UiMessage["kind"], text: string) => {
    messages.push({ seq: ++sequence, kind, text: text.slice(0, 500), at: new Date().toISOString() });
    if (messages.length > MAX_MESSAGES) messages.shift();
};

/** Subscribes once; later calls do nothing. */
export function trackUiEvents(bus: PubSub = PubSub.default): void {
    if (installed) return;
    installed = true;
    bus.sub("statusBarTip", (tip) => {
        statusTip = translate(tip);
    });
    bus.sub("clearStatusBarTip", () => {
        statusTip = undefined;
    });
    bus.sub("showToast", (message, ...args) => remember("toast", translate(message, args)));
    bus.sub("displayError", (message) => remember("error", translate(String(message))));
}

/** The prompt of the running command, when it shows one. */
export function currentStatusTip(): string | undefined {
    return statusTip;
}

/** The sequence number of the latest message, to ask later for only what came after it. */
export function messageSequence(): number {
    return sequence;
}

/** The latest toasts and errors, oldest first; `after` keeps only those after that sequence number. */
export function recentMessages(after = 0): UiMessage[] {
    return messages.filter((message) => message.seq > after);
}
