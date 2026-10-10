// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, beforeEach, describe, expect, test } from "@rstest/core";

// Mock CSS module
rs.mock("../src/toast/toast.module.css", () => ({
    toast: "toast-toast",
    message: "toast-message",
    actions: "toast-actions",
    close: "toast-close",
    info: "toast-info",
    error: "toast-error",
    warning: "toast-warning",
}));

// Mock I18n
import "./_helpers/mockCoreI18n";

import { Toast } from "../src/toast";

function getToast(): HTMLElement | null {
    return document.querySelector("[data-toast]");
}

function getToasts(): NodeListOf<HTMLElement> {
    return document.querySelectorAll("[data-toast]");
}

function clear() {
    Toast.dismiss();
    document.body.querySelectorAll("[data-toast]").forEach((el) => {
        el.remove();
    });
}

describe("Toast", () => {
    beforeEach(clear);
    afterEach(clear);

    describe("info", () => {
        test("should append a toast element to document.body", () => {
            const before = document.body.children.length;
            Toast.info("test.message" as unknown as Parameters<typeof Toast.info>[0]);
            expect(document.body.children.length).toBeGreaterThan(before);
        });

        test("should set the translated text as textContent", () => {
            Toast.info("test.message" as unknown as Parameters<typeof Toast.info>[0]);
            const toast = getToast();
            expect(toast).not.toBeNull();
            expect(toast?.textContent).toBe("test.message");
            expect(toast?.dataset["toast"]).toBe("info");
            expect(toast?.className).toBe("toast-toast toast-info");
        });
    });

    describe("error", () => {
        test("should display error message directly (no translation)", () => {
            Toast.error("Connection failed");
            const toast = getToast();
            expect(toast).not.toBeNull();
            expect(toast?.textContent).toBe("Connection failed");
            expect(toast?.className).toBe("toast-toast toast-error");
        });
    });

    describe("warn", () => {
        test("should display warning message directly", () => {
            Toast.warn("Low memory");
            const toast = getToast();
            expect(toast).not.toBeNull();
            expect(toast?.textContent).toBe("Low memory");
            expect(toast?.dataset["toast"]).toBe("warning");
        });
    });

    describe("auto-dismiss behavior", () => {
        test("should replace previous toast when showing a new one", () => {
            Toast.info("first" as unknown as Parameters<typeof Toast.info>[0]);
            const first = getToast();
            expect(first?.textContent).toBe("first");

            Toast.info("second" as unknown as Parameters<typeof Toast.info>[0]);
            // The first toast should be removed, second should show
            const toasts = getToasts();
            expect(toasts.length).toBe(1);
        });

        test("should show only one toast at a time after multiple calls", () => {
            Toast.info("a" as unknown as Parameters<typeof Toast.info>[0]);
            Toast.info("b" as unknown as Parameters<typeof Toast.info>[0]);
            Toast.error("c");

            const toasts = getToasts();
            expect(toasts.length).toBe(1);
            expect(toasts[0]?.textContent ?? "").toBe("c");
        });

        test("a plain toast goes after two seconds, one with actions stays twelve", () => {
            rs.useFakeTimers();
            try {
                Toast.info("plain" as unknown as Parameters<typeof Toast.info>[0]);
                rs.advanceTimersByTime(1999);
                expect(getToasts().length).toBe(1);
                rs.advanceTimersByTime(1);
                expect(getToasts().length).toBe(0);

                Toast.show({ message: "with actions", actions: [{ label: "Do", run: () => {} }] });
                rs.advanceTimersByTime(11_999);
                expect(getToasts().length).toBe(1);
                rs.advanceTimersByTime(1);
                expect(getToasts().length).toBe(0);
            } finally {
                rs.useRealTimers();
            }
        });
    });

    describe("actions", () => {
        test("renders a button per action plus a dismiss button; choosing one runs it and closes the toast", () => {
            const runs: string[] = [];
            Toast.show({
                message: "Downloaded part.step",
                actions: [
                    { label: "Open in default app", run: () => void runs.push("default") },
                    { label: "Open in FreeCAD", run: async () => void runs.push("freecad") },
                ],
            });
            const toast = getToast();
            expect(toast).not.toBeNull();
            expect(toast?.querySelector("span")?.textContent).toBe("Downloaded part.step");
            const buttons = [...toast!.querySelectorAll("button")];
            expect(buttons.map((button) => button.textContent)).toEqual([
                "Open in default app",
                "Open in FreeCAD",
                "×",
            ]);
            expect(buttons[2].getAttribute("aria-label")).toBe("toast.dismiss");

            buttons[1].click();
            expect(runs).toEqual(["freecad"]);
            expect(getToasts().length).toBe(0);
        });

        test("the dismiss button closes the toast without running anything", () => {
            let ran = false;
            Toast.show({
                message: "m",
                actions: [
                    {
                        label: "Do",
                        run: () => {
                            ran = true;
                        },
                    },
                ],
            });
            getToast()!.querySelector<HTMLButtonElement>("button[aria-label]")!.click();
            expect(ran).toBe(false);
            expect(getToasts().length).toBe(0);
        });

        test("a failing action shows its message as an error toast", async () => {
            Toast.show({
                message: "m",
                actions: [{ label: "Fail", run: () => Promise.reject(new Error("bridge refused")) }],
            });
            getToast()!.querySelector("button")!.click();
            await new Promise((resolve) => setTimeout(resolve, 0));
            const toast = getToast();
            expect(toast?.dataset["toast"]).toBe("error");
            expect(toast?.textContent).toBe("bridge refused");
        });
    });
});
