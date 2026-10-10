// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { CommandStore, type IApplication, type IView, PubSub } from "@chili3d/core";
import { TestDocument, TestFeatureListNode, TestStepNode } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { ConsoleEngine, parseOptions, tokenize } from "../src/console/consoleEngine";

/** A document with a sketch-like step, a body with two features and two variables. */
function fixture() {
    const document = new TestDocument();
    const sketch = new TestStepNode(document, "Sketch 1");
    const body = new TestFeatureListNode(document, "Bracket", [
        { id: "f1", nodeIds: ["Sketch 1"] },
        { id: "f2" },
    ]);
    document.modelManager.addNode(sketch, body);
    document.variables.setItems([
        { id: "v1", name: "width", type: "length", expression: "40 mm" },
        { id: "v2", name: "count", type: "unitless", expression: "3" },
    ]);
    const camera = {
        cameraPosition: { x: 0, y: -100, z: 0, distanceTo: () => 100 },
        cameraTarget: { x: 0, y: 0, z: 0 },
        lookAt: rs.fn((_eye: unknown, _target: unknown, _up: unknown) => {}),
        fitContent: rs.fn(() => {}),
    };
    const view = { document, cameraController: camera, update: () => {} } as unknown as IView;
    const app = { activeView: view } as unknown as IApplication;
    const engine = new ConsoleEngine(app);
    return { document, sketch, body, engine, camera };
}

afterEach(() => {
    rs.restoreAllMocks();
});

test("lines tokenize with quotes and split into words and --options", () => {
    expect(tokenize('lookup "End Cap" --type feature --exact')).toEqual([
        "lookup",
        "End Cap",
        "--type",
        "feature",
        "--exact",
    ]);
    expect(parseOptions(["End Cap", "--type", "feature", "--exact", "--limit", "5"])).toEqual({
        words: ["End Cap"],
        options: { type: "feature", exact: true, limit: "5" },
    });
});

test("LOOKUP lists nodes, features and variables with their type and folder, filtered and limited", async () => {
    const { engine } = fixture();
    const all = await engine.run("LOOKUP");
    expect(all.kind).toBe("query");
    expect(all.result.lines).toEqual(["-> 6 result(s)"]);
    expect(all.result.table?.columns).toEqual(["#", "Name", "Type", "Folder"]);
    expect(all.result.table?.rows.map((row) => row.slice(1))).toEqual([
        ["Sketch 1", "Sketch", ""],
        ["Bracket", "Part", ""],
        ["f1", "Feature", "Bracket"],
        ["f2", "Feature", "Bracket"],
        ["#width", "Variable", "Variables"],
        ["#count", "Variable", "Variables"],
    ]);

    const features = await engine.run("lookup --type feature --limit 1");
    expect(features.result.lines).toEqual(["-> 2 result(s) (showing 1)"]);
    expect(features.result.table?.rows).toEqual([["1", "f1", "Feature", "Bracket"]]);
    const exact = await engine.run("LOOKUP bracket --exact");
    expect(exact.result.table?.rows.map((row) => row[1])).toEqual(["Bracket"]);
    expect((await engine.run("lookup width")).result.table?.rows.map((row) => row[1])).toEqual(["#width"]);
});

test("SELECT selects nodes by name and NONE clears; unknown names are an error", async () => {
    const { engine, document, body } = fixture();
    const selected: unknown[] = [];
    rs.spyOn(document.selection, "setSelectedNodes").mockImplementation((nodes) => {
        selected.push(nodes);
        return nodes.length;
    });
    const clear = rs.spyOn(document.selection, "clearSelection").mockImplementation(() => {});
    expect((await engine.run("select bracket")).result.lines).toEqual(["-> 1 selected: Bracket"]);
    expect(selected).toEqual([[body]]);
    expect((await engine.run("SELECT none")).result.lines).toEqual(["-> OK"]);
    expect(clear).toHaveBeenCalled();
    const missing = await engine.run('select "Nope"');
    expect(missing.result.error).toBe('Nothing named "Nope".');
});

test("SET writes a variable as one undo step and creates a missing one with the expression's unit", async () => {
    const { engine, document } = fixture();
    const set = await engine.run("SET width = 50 mm");
    expect(set.kind).toBe("mutation");
    expect(set.result.lines).toEqual(["-> width = 50.00 mm"]);
    expect(document.variables.items[0].expression).toBe("50 mm");
    document.history.undo();
    expect(document.variables.items[0].expression).toBe("40 mm");

    expect((await engine.run("set #angle = 30 deg")).result.lines).toEqual(["-> angle = 30.0°"]);
    expect(document.variables.items.at(-1)).toMatchObject({
        name: "angle",
        type: "angle",
        expression: "30 deg",
    });
    expect((await engine.run("set ratio = width / 10 mm")).result.lines).toEqual(["-> ratio = 4"]);
    expect(document.variables.items.at(-1)?.type).toBe("unitless");
    expect((await engine.run("set bad = nope + 1")).result.error).toBeDefined();
    expect((await engine.run("set width")).result.error).toBe("Use SET <variable> = <expression>.");
});

test("an expression previews and runs on its own; the preview is empty for commands", async () => {
    const { engine } = fixture();
    expect(engine.preview("2 * 3 mm")).toBe("= 6.00 mm");
    expect(engine.preview("= width + 10 mm")).toBe("= 50.00 mm");
    expect(engine.preview("count * 2")).toBe("= 6");
    expect(engine.preview("lookup sketch")).toBeUndefined();
    expect(engine.preview("nonsense +")).toBeUndefined();
    const entry = await engine.run("width / 2");
    expect(entry.kind).toBe("expression");
    expect(entry.result.lines).toEqual(["-> 20.00 mm"]);
    const unknown = await engine.run("frobnicate 3");
    expect(unknown.result.error).toContain('Unknown command "frobnicate"');
});

test("VIEW turns the camera to a cube orientation or fits the model", async () => {
    const { engine, camera } = fixture();
    expect((await engine.run("view iso")).result.lines).toEqual(["-> Top Front Right"]);
    expect(camera.lookAt).toHaveBeenCalledTimes(1);
    const [eye, , up] = camera.lookAt.mock.calls[0] as [
        { x: number; y: number; z: number },
        unknown,
        { z: number },
    ];
    expect(eye.z).toBeGreaterThan(0);
    expect(up.z).toBe(1);
    expect((await engine.run("VIEW fit")).result.lines).toEqual(["-> Fitted"]);
    expect(camera.fitContent).toHaveBeenCalled();
    expect((await engine.run("view sideways")).result.error).toContain("unknown view");
});

test("suggestions match by name, description and tool name, with the console's commands first", () => {
    const { engine } = fixture();
    expect(engine.suggest("lo").map((s) => s.command.name)).toEqual(["lookup"]);
    expect(engine.suggest("lo")[0].insert).toBe("LOOKUP ");
    // By description: "variable" names SET (and LOOKUP mentions variables).
    expect(engine.suggest("variable").map((s) => s.command.name)).toContain("set");
    expect(engine.suggest("")).toEqual([]);
    expect(engine.suggest("= 2 + 2")).toEqual([]);
    for (const suggestion of engine.suggest("se")) {
        expect(suggestion.command.syntax).not.toBe("");
        expect(suggestion.command.description).not.toBe("");
    }
});

test("HELP explains commands; a tool runs through the command service; HISTORY and RECORD keep the script", async () => {
    const { engine } = fixture();
    const published: unknown[][] = [];
    rs.spyOn(PubSub.default, "pub").mockImplementation(((...args: unknown[]) => {
        published.push(args);
    }) as typeof PubSub.default.pub);
    // The application's tools, as the command store lists them once the app package loaded.
    rs.spyOn(CommandStore, "getAllCommands").mockReturnValue([{ key: "doc.save", icon: "icon-save" }]);
    expect(engine.suggest("sav")[0]?.command.name).toBe("doc.save");
    const help = await engine.run("help set");
    expect(help.result.lines[0]).toContain("SET: Sets a variable");
    expect(help.result.lines[1]).toBe("Syntax: SET <variable> = <expression>");
    expect((await engine.run("help")).result.table?.rows.map((row) => row[0])).toContain("LOOKUP");

    const tool = await engine.run("doc.save");
    expect(tool.kind).toBe("app");
    expect(published.at(-1)).toEqual(["executeCommand", "doc.save"]);

    await engine.run("record off");
    expect(engine.recording).toBe(false);
    await engine.run("lookup sketch");
    await engine.run("record on");
    const history = await engine.run("history");
    const inputs = engine.history.map((entry) => entry.input);
    expect(inputs).toEqual(["help set", "help", "doc.save", "record off", "history"]);
    expect(history.result.table?.columns).toEqual(["#", "Time", "Command", "Result"]);
    expect(engine.script()).toContain("doc.save\n; ");
    expect((await engine.run("history clear")).result.lines).toEqual(["-> Cleared"]);
    expect(engine.history).toHaveLength(0);
});
