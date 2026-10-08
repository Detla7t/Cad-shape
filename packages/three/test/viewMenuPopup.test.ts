// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config } from "@chili3d/core";
import { snappingMenuItems } from "../src/viewMenu";
import { openViewMenu } from "../src/viewMenuPopup";

test("view choices open adjacent flyouts and keyboard selection closes both menus", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    let selected = "edges",
        closed = 0;
    const close = openViewMenu(
        anchor,
        [
            {
                name: "Shaded with edges",
                checked: true,
                children: [
                    { name: "With edges", checked: true },
                    {
                        name: "Without edges",
                        checked: false,
                        action: () => {
                            selected = "solid";
                        },
                    },
                ],
            },
            { name: "Zoom to fit" },
        ],
        () => {
            closed++;
        },
    );
    try {
        const parent = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
        expect(parent).not.toBeNull();
        parent.dispatchEvent(new MouseEvent("mouseenter"));
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(2);
        expect(parent.getAttribute("aria-expanded")).toBe("true");
        expect(document.querySelector('[aria-label="Zoom to fit"]')).not.toBeNull();
        parent.focus();
        parent.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        expect(document.activeElement?.getAttribute("aria-label")).toBe("With edges");
        document.activeElement!.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
        expect(document.activeElement?.getAttribute("aria-label")).toBe("Without edges");
        (document.activeElement as HTMLButtonElement).click();
        expect(selected).toBe("solid");
        expect(closed).toBe(1);
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(0);
    } finally {
        close();
        anchor.remove();
    }
});

test("snapping options update configuration and remain open for additional changes", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const before = Config.instance.enableSnap;
    const beforeTracking = Config.instance.enableSnapTracking;
    const close = openViewMenu(anchor, snappingMenuItems(), () => {});
    try {
        const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Enable snapping"]');
        expect(toggle).not.toBeNull();
        toggle!.click();
        expect(Config.instance.enableSnap).toBe(!before);
        expect(toggle!.getAttribute("aria-checked")).toBe(String(!before));
        expect(toggle!.isConnected).toBe(true);
        const tracking = document.querySelector<HTMLButtonElement>(
            '[aria-label="Automatic sketch inferences"]',
        );
        expect(tracking).not.toBeNull();
        tracking!.click();
        expect(Config.instance.enableSnapTracking).toBe(!beforeTracking);
        toggle!.click();
        expect(Config.instance.enableSnap).toBe(before);
    } finally {
        close();
        anchor.remove();
        Config.instance.enableSnap = before;
        Config.instance.enableSnapTracking = beforeTracking;
    }
});
