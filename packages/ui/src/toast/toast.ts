// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys } from "@chili3d/core";
import style from "./toast.module.css";

export interface ToastAction {
    readonly label: string;
    /** Runs on the click; a rejected promise shows its message as an error toast. */
    readonly run: () => void | Promise<void>;
}

export interface ToastOptions {
    readonly message: string;
    readonly type?: "info" | "error" | "warning";
    /** Buttons under the message; choosing one dismisses the toast. */
    readonly actions?: readonly ToastAction[];
    /** Milliseconds on screen: 2 s for a plain message, 12 s with actions. */
    readonly duration?: number;
}

export class Toast {
    private static _lastToast: [number, HTMLElement] | undefined;

    static readonly info = (message: I18nKeys, ...args: unknown[]) => {
        Toast.show({ message: I18n.translate(message, ...args) });
    };

    static readonly error = (message: string) => {
        Toast.show({ type: "error", message });
    };

    static readonly warn = (message: string) => {
        Toast.show({ type: "warning", message });
    };

    /** Shows one toast (replacing the one on screen). */
    static show(options: ToastOptions) {
        Toast.dismiss();
        const type = options.type ?? "info";
        const toast = document.createElement("div");
        toast.className = `${style.toast} ${style[type]}`;
        toast.dataset["toast"] = type;
        toast.setAttribute("role", "status");
        const message = document.createElement("span");
        message.className = style.message;
        message.textContent = options.message;
        toast.append(message);
        const actions = options.actions ?? [];
        if (actions.length > 0) {
            const row = document.createElement("div");
            row.className = style.actions;
            for (const action of actions) {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = action.label;
                button.onclick = () => {
                    Toast.dismiss();
                    // Called inside the click so the browser still sees a user gesture (Web Share).
                    try {
                        void Promise.resolve(action.run()).catch(Toast.showError);
                    } catch (error) {
                        Toast.showError(error);
                    }
                };
                row.append(button);
            }
            const close = document.createElement("button");
            close.type = "button";
            close.className = style.close;
            close.textContent = "×";
            close.setAttribute("aria-label", I18n.translate("toast.dismiss"));
            close.onclick = () => Toast.dismiss();
            row.append(close);
            toast.append(row);
        }
        document.body.appendChild(toast);
        const duration = options.duration ?? (actions.length > 0 ? 12000 : 2000);
        Toast._lastToast = [window.setTimeout(() => Toast.dismiss(), duration), toast];
    }

    /** Removes the toast on screen, if any. */
    static dismiss() {
        if (!Toast._lastToast) return;
        clearTimeout(Toast._lastToast[0]);
        Toast._lastToast[1].remove();
        Toast._lastToast = undefined;
    }

    private static readonly showError = (error: unknown) => {
        Toast.error(error instanceof Error ? error.message : String(error));
    };
}
