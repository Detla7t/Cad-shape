// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandKeys,
    CommandStore,
    type IApplication,
    type ICommand,
    type IView,
    OperationLog,
    PubSub,
    type XYZLike,
} from "@chili3d/core";
import { createMockApplication, createMockView, TestDocument } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { resetPointerState } from "../src/automation/domInput";
import type { Tool } from "../src/llm/types";
import { buildTools } from "../src/tools";
import { standardView, standardViewNames } from "../src/tools/standardViews";

const tools = buildTools("automation");

function getTool(name: string): Tool {
    const tool = tools.find((t) => t.name === name);
    expect(tool, name).toBeDefined();
    return tool!;
}

async function run(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const result = await getTool(name).handler(args);
    return JSON.parse(typeof result === "string" ? result : result.content);
}

/** A camera controller holding real state, as the Three.js one does. */
function fakeCamera() {
    const state = {
        position: { x: 100, y: -100, z: 100 } as XYZLike,
        target: { x: 0, y: 0, z: 0 } as XYZLike,
        up: { x: 0, y: 0, z: 1 } as XYZLike,
    };
    return {
        cameraType: "perspective" as "perspective" | "orthographic",
        get cameraPosition() {
            return { ...state.position };
        },
        get cameraTarget() {
            return { ...state.target };
        },
        get cameraUp() {
            return { ...state.up };
        },
        lookAt(eye: XYZLike, target: XYZLike, up: XYZLike) {
            state.position = { ...eye };
            state.target = { ...target };
            state.up = { ...up };
        },
        animateLookAt(eye: XYZLike, target: XYZLike, up: XYZLike) {
            this.lookAt(eye, target, up);
            return Promise.resolve();
        },
        pan: rs.fn((_dx: number, _dy: number) => {}),
        fitContent: () => {},
        onPropertyChanged: () => {},
        removePropertyChanged: () => {},
    };
}

function setupApp(viewOverrides: Partial<IView> = {}) {
    const app = createMockApplication();
    const document = new TestDocument();
    const camera = fakeCamera();
    const view = createMockView({
        document,
        cameraController: camera as never,
        ...viewOverrides,
    } as Partial<IView>);
    app.documents.add(document);
    app.views.push(view);
    app.activeView = view;
    rs.stubGlobal("app", app);
    return { app, view, camera, document };
}

afterEach(() => {
    rs.unstubAllGlobals();
    document.body.innerHTML = "";
    resetPointerState();
});

describe("standard views", () => {
    test("names every face, edge and corner of the view cube once", () => {
        const names = standardViewNames();
        expect(names).toHaveLength(26);
        expect(new Set(names.map((name) => (standardView(name) as { name: string }).name)).size).toBe(26);
    });

    test("iso is the top front right corner", () => {
        expect(standardView("iso")).toEqual(standardView("right front top"));
    });
});

describe("camera tools", () => {
    test("set_camera then get_camera round-trips eye, target, up and projection", async () => {
        const { camera } = setupApp();

        const set = await run("set_camera", {
            eye: { x: 10, y: 20, z: 30 },
            target: { x: 1, y: 2, z: 3 },
            up: { x: 0, y: 0, z: 1 },
            projection: "orthographic",
        });
        const got = await run("get_camera");

        expect(set.ok).toBe(true);
        expect(got.eye).toEqual({ x: 10, y: 20, z: 30 });
        expect(got.target).toEqual({ x: 1, y: 2, z: 3 });
        expect(got.projection).toBe("orthographic");
        expect(camera.cameraType).toBe("orthographic");
        // The up vector is made perpendicular to the view: dot(up, direction) = 0.
        const d = got.direction;
        expect(got.up.x * d.x + got.up.y * d.y + got.up.z * d.z).toBeCloseTo(0, 6);
    });

    test("direction plus viewHeight places the eye at the matching distance", async () => {
        setupApp();

        const got = await run("set_camera", {
            target: { x: 0, y: 0, z: 0 },
            direction: { x: 0, y: 0, z: -1 },
            viewHeight: 2 * Math.tan((45 * Math.PI) / 360) * 50,
        });

        expect(got.eye.x).toBeCloseTo(0, 6);
        expect(got.eye.z).toBeCloseTo(50, 6);
        expect(got.standardView).toBe("Top");
        expect(got.viewHeight).toBeCloseTo(2 * Math.tan((45 * Math.PI) / 360) * 50, 6);
    });

    test("pan_zoom_view pans like a pan drag and zooms around the target", async () => {
        const { camera } = setupApp();

        const result = await run("pan_zoom_view", { dx: 5, dy: -3, zoom: 2 });

        expect(camera.pan).toHaveBeenCalledWith(5, -3);
        expect(result.eye).toEqual({ x: 50, y: -50, z: 50 });
    });

    test("set_camera rejects malformed points", async () => {
        setupApp();
        expect((await run("set_camera", { eye: { x: 1 } })).error).toBe("eye must be { x, y, z } numbers");
    });
});

describe("command tools", () => {
    class InstantCommand implements ICommand {
        async execute() {}
    }
    class WaitingCommand implements ICommand {
        release?: () => void;
        execute() {
            return new Promise<void>((resolve) => {
                this.release = resolve;
            });
        }
        async cancel() {
            this.release?.();
        }
        dispose() {}
    }

    /** What CommandService does with `executeCommand`: run it, log it, track it as executing. */
    function fakeCommandService(app: IApplication) {
        const handler = async (key: CommandKeys) => {
            const ctor = CommandStore.getCommand(key)!;
            const operation = OperationLog.begin("command.execute", { command: key });
            const command = new ctor();
            app.executingCommand = command;
            PubSub.default.pub("statusBarTip", "prompt.pickFistPoint" as never);
            await command.execute(app);
            operation.finish("success");
            app.executingCommand = undefined;
        };
        PubSub.default.sub("executeCommand", handler);
        return () => PubSub.default.remove("executeCommand", handler);
    }

    beforeEach(() => {
        CommandStore.registerCommand(InstantCommand, { key: "test.instant", icon: "" });
        CommandStore.registerCommand(WaitingCommand, { key: "test.waiting", icon: "" });
    });

    afterEach(() => {
        CommandStore.unregisterCommand("test.instant");
        CommandStore.unregisterCommand("test.waiting");
    });

    test("execute_command runs a command through the bus and reports it finished", async () => {
        const { app } = setupApp();
        const stop = fakeCommandService(app);
        try {
            const result = await run("execute_command", { command: "test.instant" });

            expect(result.status).toBe("finished");
            expect(result.finished).toEqual([
                expect.objectContaining({ command: "test.instant", outcome: "success" }),
            ]);
        } finally {
            stop();
        }
    });

    test("a command waiting for input is reported with its prompt, and cancel_command ends it", async () => {
        const { app } = setupApp();
        const stop = fakeCommandService(app);
        try {
            const result = await run("execute_command", { command: "test.waiting", waitMs: 100 });
            expect(result).toMatchObject({ status: "waiting", running: "test.waiting", cancelable: true });
            expect(typeof result.prompt).toBe("string");

            const cancelled = await run("cancel_command");
            expect(cancelled).toMatchObject({
                ok: true,
                cancelled: true,
                command: "test.waiting",
                stillRunning: false,
            });
        } finally {
            stop();
        }
    });

    test("an unknown command id is an error with similar ids", async () => {
        setupApp();
        const result = await run("execute_command", { command: "test.instan" });
        expect(result.error).toBe('no command "test.instan"');
    });

    test("list_commands filters registered commands by id", async () => {
        setupApp();
        const result = await run("list_commands", { query: "test." });
        expect(result.commands.map((c: { id: string }) => c.id)).toEqual(["test.instant", "test.waiting"]);
    });
});

describe("view_pointer", () => {
    /** A viewport element whose listeners stand in for the view's event handlers. */
    function viewport() {
        const dom = document.createElement("div");
        const canvas = document.createElement("canvas");
        dom.append(canvas);
        document.body.append(dom);
        const seen: {
            type: string;
            x: number;
            y: number;
            button: number;
            buttons: number;
            target: EventTarget | null;
        }[] = [];
        for (const type of [
            "pointermove",
            "pointerdown",
            "pointerup",
            "click",
            "dblclick",
            "wheel",
            "contextmenu",
        ]) {
            dom.addEventListener(type, (event) => {
                const e = event as PointerEvent;
                seen.push({
                    type,
                    x: e.clientX,
                    y: e.clientY,
                    button: e.button,
                    buttons: e.buttons,
                    target: e.target,
                });
            });
        }
        return { dom, canvas, seen };
    }

    test("a click reaches the viewport's pointer handlers at the view pixel", async () => {
        const { dom, canvas, seen } = viewport();
        setupApp({ dom } as Partial<IView>);

        const result = await run("view_pointer", { action: "click", x: 120, y: 80 });

        expect(result.ok).toBe(true);
        expect(seen.map((e) => e.type)).toEqual(["pointermove", "pointerdown", "pointerup", "click"]);
        expect(seen[1]).toMatchObject({ x: 120, y: 80, button: 0, buttons: 1, target: canvas });
        expect(seen[2]).toMatchObject({ button: 0, buttons: 0 });
    });

    test("a world point is projected through the camera", async () => {
        const { dom, seen } = viewport();
        setupApp({ dom } as Partial<IView>);

        await run("view_pointer", { action: "move", point: { x: 10, y: 20, z: 0 } });

        // createMockView projects (x, y) to (x + 400, y + 300).
        expect(seen[0]).toMatchObject({ type: "pointermove", x: 410, y: 320 });
    });

    test("a drag presses, moves along the path with the button held, and releases", async () => {
        const { dom, seen } = viewport();
        setupApp({ dom } as Partial<IView>);

        await run("view_pointer", {
            action: "drag",
            path: [
                { x: 0, y: 0 },
                { x: 100, y: 0 },
            ],
            steps: 4,
            button: "middle",
        });

        const moves = seen.filter((e) => e.type === "pointermove");
        expect(seen.find((e) => e.type === "pointerdown")).toMatchObject({ button: 1, buttons: 4 });
        expect(moves.slice(1).map((e) => e.x)).toEqual([25, 50, 75, 100]);
        expect(moves.slice(1).every((e) => e.buttons === 4)).toBe(true);
        expect(seen.at(-1)).toMatchObject({ type: "pointerup", x: 100, buttons: 0 });
    });

    test("double_click ends with dblclick and wheel carries its delta", async () => {
        const { dom, seen } = viewport();
        setupApp({ dom } as Partial<IView>);

        await run("view_pointer", { action: "double_click", x: 5, y: 5 });
        expect(seen.filter((e) => e.type === "click")).toHaveLength(2);
        expect(seen.at(-1)?.type).toBe("dblclick");

        let delta = 0;
        dom.addEventListener("wheel", (e) => {
            delta = (e as WheelEvent).deltaY;
        });
        await run("view_pointer", { action: "wheel", x: 5, y: 5, deltaY: 240 });
        expect(delta).toBe(240);
    });

    test("press_key sends a hotkey that bubbles to window", async () => {
        setupApp();
        const keys: string[] = [];
        const listener = (e: KeyboardEvent) => keys.push(`${e.ctrlKey ? "ctrl+" : ""}${e.key}`);
        window.addEventListener("keydown", listener);
        try {
            const result = await run("press_key", { key: "Ctrl+Z" });
            expect(result).toMatchObject({ ok: true, key: "Z", modifiers: ["ctrl"] });
            expect(keys).toEqual(["ctrl+Z"]);
        } finally {
            window.removeEventListener("keydown", listener);
        }
    });
});

describe("UI tools", () => {
    function page() {
        document.body.innerHTML = `
            <div role="toolbar" aria-label="Ribbon">
                <x-ribbon-button role="button" data-command="create.box" tabindex="0"><span>Box</span></x-ribbon-button>
                <button id="extrude">Extrude</button>
                <button>Apply</button>
                <button>Apply</button>
                <button hidden>Secret</button>
            </div>
            <label>Width <input id="width" value="10"></label>
            <select aria-label="Units"><option value="mm">Millimetre</option><option value="in">Inch</option></select>
            <div role="dialog" aria-label="Fillet"><p>Radius of the fillet</p><input aria-label="Radius" value="2"></div>`;
        const row = document.createElement("div");
        row.textContent = "Body 1";
        row.onclick = rs.fn();
        document.body.append(row);
        return { row };
    }

    test("ui_snapshot lists visible interactive elements with roles, names, state and stable refs", async () => {
        page();

        const first = await run("ui_snapshot");
        const second = await run("ui_snapshot");

        const byName = (name: string) => first.nodes.find((node: { name: string }) => node.name === name);
        expect(byName("Box")).toMatchObject({
            role: "button",
            command: "create.box",
            in: 'toolbar "Ribbon"',
        });
        expect(byName("Width")).toMatchObject({ role: "textbox", value: "10" });
        expect(byName("Units")).toMatchObject({ role: "combobox", value: "Millimetre" });
        expect(byName("Body 1")).toMatchObject({ role: "button" });
        expect(byName("Secret")).toBeUndefined();
        expect(second.nodes.map((n: { ref: string }) => n.ref)).toEqual(
            first.nodes.map((n: { ref: string }) => n.ref),
        );
        expect(first.dialogs).toEqual([expect.objectContaining({ name: "Fillet" })]);
    });

    test("ui_click clicks by visible text and by ref", async () => {
        const { row } = page();
        const clicks: string[] = [];
        document.querySelector("x-ribbon-button")!.addEventListener("click", () => clicks.push("box"));

        const byText = await run("ui_click", { text: "Box" });
        expect(byText.ok).toBe(true);
        expect(clicks).toEqual(["box"]);

        const snapshot = await run("ui_snapshot", { query: "Body 1" });
        await run("ui_click", { ref: snapshot.nodes[0].ref });
        expect(row.onclick).toHaveBeenCalledTimes(1);
    });

    test("several matches are an error listing them, unless index picks one", async () => {
        page();
        const buttons = [...document.querySelectorAll("button")].filter((b) => b.textContent === "Apply");
        const clicked = rs.fn();
        buttons[1].addEventListener("click", clicked);

        const ambiguous = await run("ui_click", { text: "Apply" });
        expect(ambiguous.error).toContain("2 elements match");

        await run("ui_click", { text: "Apply", index: 1 });
        expect(clicked).toHaveBeenCalledTimes(1);
    });

    test("ui_type and ui_select change fields with input and change events", async () => {
        page();
        const input = document.querySelector<HTMLInputElement>("#width")!;
        const select = document.querySelector("select")!;
        const events: string[] = [];
        input.addEventListener("input", () => events.push("input"));
        input.addEventListener("change", () => events.push("change"));
        select.addEventListener("change", () => events.push(`select:${select.value}`));

        await run("ui_type", { label: "Width", value: "25 mm" });
        const picked = await run("ui_select", { label: "Units", option: "Inch" });

        expect(input.value).toBe("25 mm");
        expect(picked.selected).toEqual({ value: "in", label: "Inch" });
        expect(events).toEqual(["input", "change", "select:in"]);
    });

    test("ui_snapshot's query matches names, not roles, and role filters", async () => {
        page();

        const byQuery = await run("ui_snapshot", { query: "box" });
        const byRole = await run("ui_snapshot", { role: "combobox" });

        expect(byQuery.nodes.map((n: { name: string }) => n.name)).toEqual(["Box"]);
        expect(byRole.nodes.map((n: { name: string }) => n.name)).toEqual(["Units"]);
    });

    test("a label names the labelled element itself, not its clickable ancestor", async () => {
        page();

        const toolbar = await run("ui_read", { label: "Ribbon" });

        expect(toolbar).toMatchObject({ role: "toolbar", name: "Ribbon" });
    });

    test("ui_read reads the open dialog's text and fields", async () => {
        page();

        const result = await run("ui_read");

        expect(result.name).toBe("Fillet");
        expect(result.text).toContain("Radius of the fillet");
        expect(result.fields).toEqual([expect.objectContaining({ name: "Radius", value: "2" })]);
    });
});

describe("wait_for", () => {
    test("times out with ok:false when the element never appears", async () => {
        setupApp();
        const started = Date.now();

        const result = await run("wait_for", { condition: "element", selector: "#never", timeoutMs: 120 });

        expect(result.ok).toBe(false);
        expect(result.error).toBe("timed out after 120 ms");
        expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    });

    test("resolves once the element appears", async () => {
        setupApp();
        setTimeout(() => {
            const done = document.createElement("div");
            done.id = "done";
            done.textContent = "done";
            document.body.append(done);
        }, 40);

        const result = await run("wait_for", {
            condition: "element",
            selector: "#done",
            timeoutMs: 3000,
            stableMs: 0,
        });

        expect(result.ok).toBe(true);
        expect(result.waitedMs).toBeGreaterThanOrEqual(30);
    });
});

describe("state and script tools", () => {
    test("get_app_state reports documents, selection and the undo stack", async () => {
        const { document: doc } = setupApp();
        doc.history.add({ name: "Extrude 1", undo: () => {}, redo: () => {}, dispose: () => {} });

        const state = await run("get_app_state");

        expect(state.documents).toEqual([expect.objectContaining({ id: doc.id, active: true })]);
        expect(state.history).toMatchObject({ undo: ["Extrude 1"], undoCount: 1, redoCount: 0 });
        expect(state.command.running).toBe(false);
    });

    test("get_operation_log filters by operation prefix and sequence", async () => {
        const before = OperationLog.snapshot().at(-1)?.sequence ?? 0;
        OperationLog.record("automation.test", { n: 1 });
        OperationLog.record("other.thing");

        const result = await run("get_operation_log", {
            operation: "automation.test",
            afterSequence: before,
        });

        expect(result.events).toEqual([
            expect.objectContaining({ operation: "automation.test", context: { n: 1 } }),
        ]);
    });

    test("evaluate_script returns an expression's value, runs bodies and reports errors", async () => {
        setupApp();

        expect(await run("evaluate_script", { code: "1 + 2" })).toEqual({ ok: true, value: 3 });
        expect(await run("evaluate_script", { code: "const n = app.documents.size; return { n };" })).toEqual(
            {
                ok: true,
                value: { n: 1 },
            },
        );
        expect((await run("evaluate_script", { code: "throw new Error('nope')" })).error).toBe("nope");
    });

    test("evaluate_script is only offered to the automation bridge", () => {
        expect(buildTools("assistant").map((t) => t.name)).not.toContain("evaluate_script");
        expect(getTool("evaluate_script").availability).toBe("external");
    });
});
