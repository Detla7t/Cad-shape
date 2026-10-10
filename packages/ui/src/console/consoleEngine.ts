// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { standardView } from "@chili3d/ai";
import {
    ANGLE_UNITS,
    type CommandKeys,
    CommandStore,
    download,
    evaluateExpression,
    FolderNode,
    formatDocumentValue,
    I18n,
    type I18nKeys,
    type IApplication,
    type IDocument,
    type INode,
    isFeatureListNode,
    isNodeIcon,
    LENGTH_UNITS,
    PubSub,
    ReferencePlaneNode,
    Transaction,
    UNITLESS,
    unitSpecEquals,
    type VariableData,
} from "@chili3d/core";

/**
 * The command window's engine (AutoCAD's command line for the Part Studio): typed lines are
 * console commands — LOOKUP, SELECT, SET, VIEW, UNDO/REDO, HELP, HISTORY — or any of the
 * application's commands by key or name, and a bare expression previews its value. Every
 * command carries its description, syntax, arguments and examples for the suggestions and the
 * explanation under the input. Mutations go through the normal commands and transactions, so
 * they are undo steps and operation-log events like any other edit; the history keeps every
 * line (with its result) and saves it as a script to replay by hand.
 */

export interface ConsoleArgument {
    readonly name: string;
    readonly description: string;
}

export interface ConsoleResultTable {
    readonly columns: readonly string[];
    readonly rows: readonly (readonly string[])[];
}

export interface ConsoleResult {
    readonly lines: readonly string[];
    readonly table?: ConsoleResultTable;
    readonly error?: string;
    /** False keeps the line out of the history (HISTORY clear leaves it empty). */
    readonly keep?: boolean;
}

export interface ConsoleContext {
    readonly app: IApplication;
    readonly document: IDocument | undefined;
}

/** `query` reads; `mutation` changes the document; `app` starts one of the application's tools. */
export type ConsoleCommandKind = "query" | "mutation" | "app";

export interface ConsoleCommand {
    readonly name: string;
    readonly kind: ConsoleCommandKind;
    readonly description: string;
    readonly syntax: string;
    readonly arguments?: readonly ConsoleArgument[];
    readonly examples?: readonly string[];
    readonly run: (
        args: readonly string[],
        context: ConsoleContext,
    ) => ConsoleResult | Promise<ConsoleResult>;
}

export interface ConsoleEntry {
    readonly time: string;
    readonly input: string;
    readonly result: ConsoleResult;
    readonly kind: ConsoleCommandKind | "expression";
}

export interface ConsoleSuggestion {
    readonly command: ConsoleCommand;
    /** What Tab inserts. */
    readonly insert: string;
}

/** The words of a line: quotes group, `--flag value` pairs are kept as given. */
export function tokenize(line: string): string[] {
    const tokens: string[] = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    for (const match of line.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3]);
    return tokens;
}

/** Splits args into the positional words and the `--name value` / `--flag` options. */
export function parseOptions(args: readonly string[]): {
    words: string[];
    options: Record<string, string | true>;
} {
    const words: string[] = [];
    const options: Record<string, string | true> = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!arg.startsWith("--")) {
            words.push(arg);
            continue;
        }
        const name = arg.slice(2).toLowerCase();
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
            options[name] = next;
            i++;
        } else options[name] = true;
    }
    return { words, options };
}

const ok = (...lines: string[]): ConsoleResult => ({ lines });
const fail = (error: string): ConsoleResult => ({ lines: [], error });

const timeOf = (date: Date) =>
    `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;

/** "Sketch", "Part", "Plane", "Folder", "Variable", else the class name. */
export function nodeTypeName(node: INode): string {
    if (isFeatureListNode(node)) return "Part";
    if (node instanceof ReferencePlaneNode) return "Plane";
    if (node instanceof FolderNode) return "Folder";
    if (isNodeIcon(node) && node.icon === "icon-sketchEdit") return "Sketch";
    return node.constructor.name.replace(/Node$/, "") || "Node";
}

interface LookupRow {
    readonly name: string;
    readonly type: string;
    readonly folder: string;
    readonly node?: INode;
}

/** Everything LOOKUP sees: the nodes, each part's features, the variables. */
export function lookupRows(document: IDocument): LookupRow[] {
    const rows: LookupRow[] = [];
    for (const node of document.modelManager.findNodes()) {
        if (node === document.modelManager.rootNode) continue;
        const folder =
            node.parent === undefined || node.parent === document.modelManager.rootNode
                ? ""
                : node.parent.name;
        rows.push({ name: node.name, type: nodeTypeName(node), folder, node });
        if (isFeatureListNode(node)) {
            for (const feature of node.featureItems()) {
                rows.push({
                    name: feature.name ?? I18n.translate(feature.display),
                    type: "Feature",
                    folder: node.name,
                    node,
                });
            }
        }
    }
    for (const variable of document.variables.items) {
        rows.push({ name: `#${variable.name}`, type: "Variable", folder: "Variables" });
    }
    return rows;
}

const HELP: ConsoleCommand = {
    name: "help",
    kind: "query",
    description: "Lists the console's commands, or explains one: what it does, its syntax and examples.",
    syntax: "HELP [command]",
    arguments: [{ name: "command", description: "A command name; without one, every command." }],
    examples: ["HELP", "HELP lookup"],
    run: () => ok(),
};

const LOOKUP: ConsoleCommand = {
    name: "lookup",
    kind: "query",
    description:
        "Search for values, geometry, or variables and display matching results. The search is a name, a type or a property; results can be selected with SELECT.",
    syntax: "LOOKUP <search> [--type <type>] [--in <scope>] [--exact] [--limit <n>]",
    arguments: [
        { name: "search", description: "Name, type, or property to search for." },
        {
            name: "--type <type>",
            description: "Filter by result type (feature, sketch, part, plane, variable).",
        },
        { name: "--in <scope>", description: "Scope to search in (active, all, selection)." },
        { name: "--exact", description: "Match exact name only." },
        { name: "--limit <n>", description: "Maximum number of results to return." },
    ],
    examples: ["LOOKUP sketch", "LOOKUP --type feature --in active", "LOOKUP endcap --exact"],
    run: (args, { document }) => {
        if (document === undefined) return fail("No document is open.");
        const { words, options } = parseOptions(args);
        const search = words.join(" ").toLowerCase();
        const type = typeof options["type"] === "string" ? options["type"].toLowerCase() : undefined;
        const limit = typeof options["limit"] === "string" ? Number(options["limit"]) : undefined;
        const selected =
            options["in"] === "selection" ? new Set(document.selection.getSelectedNodes()) : undefined;
        let rows = lookupRows(document).filter((row) => {
            if (type !== undefined && row.type.toLowerCase() !== type) return false;
            if (selected !== undefined && (row.node === undefined || !selected.has(row.node))) return false;
            if (search === "") return true;
            const name = row.name.toLowerCase();
            if (options["exact"] === true) return name === search;
            return name.includes(search) || row.type.toLowerCase() === search;
        });
        const total = rows.length;
        if (limit !== undefined && Number.isFinite(limit) && limit >= 0) rows = rows.slice(0, limit);
        return {
            lines: [`-> ${total} result(s)${rows.length < total ? ` (showing ${rows.length})` : ""}`],
            table: {
                columns: ["#", "Name", "Type", "Folder"],
                rows: rows.map((row, i) => [String(i + 1), row.name, row.type, row.folder]),
            },
        };
    },
};

const SELECT: ConsoleCommand = {
    name: "select",
    kind: "query",
    description: "Selects nodes by name (a part, a sketch, a plane); NONE clears the selection.",
    syntax: "SELECT <name> [<name> ...] | SELECT NONE",
    arguments: [{ name: "name", description: "A node's name; quote names with spaces." }],
    examples: ['SELECT "Sketch 1"', "SELECT NONE"],
    run: (args, { document }) => {
        if (document === undefined) return fail("No document is open.");
        if (args.length === 1 && args[0].toLowerCase() === "none") {
            document.selection.clearSelection();
            return ok("-> OK");
        }
        const wanted = args.map((name) => name.toLowerCase());
        const nodes = document.modelManager.findNodes((node) => wanted.includes(node.name.toLowerCase()));
        if (nodes.length === 0) return fail(`Nothing named ${args.map((a) => `"${a}"`).join(", ")}.`);
        document.selection.setSelectedNodes(nodes, false);
        return ok(`-> ${nodes.length} selected: ${nodes.map((node) => node.name).join(", ")}`);
    },
};

const SET: ConsoleCommand = {
    name: "set",
    kind: "mutation",
    description:
        "Sets a variable of the document's variable table to an expression (a new variable is created with the expression's unit). The change is one undo step and every feature reading it rebuilds.",
    syntax: "SET <variable> = <expression>",
    arguments: [
        { name: "variable", description: "The variable's name, with or without #." },
        { name: "expression", description: "A value or expression: 8 in, width / 2, sqrt(a*a + b*b)." },
    ],
    examples: ["SET OD = 8 in", "SET #flange = duct_od < 5 in ? 0.375 in : 0.5 in"],
    run: (args, { document }) => {
        if (document === undefined) return fail("No document is open.");
        const text = args.join(" ");
        const match = /^#?([A-Za-z_][\w]*)\s*=\s*(.+)$/.exec(text);
        if (match === null) return fail("Use SET <variable> = <expression>.");
        const [, name, expression] = match;
        const evaluated = evaluateExpression(expression, document.variables.scope);
        if (!evaluated.isOk) return fail(evaluated.error);
        const items = [...document.variables.items];
        const index = items.findIndex((item) => item.name === name);
        const unit = evaluated.value.unit;
        const type = unitSpecEquals(unit, LENGTH_UNITS)
            ? "length"
            : unitSpecEquals(unit, ANGLE_UNITS)
              ? "angle"
              : unitSpecEquals(unit, UNITLESS)
                ? "unitless"
                : undefined;
        if (type === undefined)
            return fail("The expression's unit is not a length, an angle or a plain number.");
        const item: VariableData =
            index >= 0
                ? { ...items[index], expression }
                : { id: `console-${Date.now().toString(36)}`, name, type, expression };
        if (index >= 0) items[index] = item;
        else items.push(item);
        Transaction.execute(document, `SET ${name}`, () => document.variables.setItems(items));
        return ok(`-> ${name} = ${formatValue(document, evaluated.value.value, unit)}`);
    },
};

const VIEW: ConsoleCommand = {
    name: "view",
    kind: "query",
    description: "Turns the camera to a view cube orientation, or fits the model in the view.",
    syntax: "VIEW <front|back|left|right|top|bottom|iso|'top front right'> | VIEW FIT",
    arguments: [
        { name: "orientation", description: `A face, edge or corner of the view cube, ISO, or FIT.` },
    ],
    examples: ["VIEW iso", "VIEW top", "VIEW fit"],
    run: (args, { app }) => {
        const view = app.activeView;
        if (view === undefined) return fail("No view is open.");
        const name = args.join(" ");
        if (name.toLowerCase() === "fit" || name === "") {
            view.cameraController.fitContent();
            view.update();
            return ok("-> Fitted");
        }
        const standard = standardView(name);
        if (typeof standard === "string") return fail(standard);
        const camera = view.cameraController;
        const target = camera.cameraTarget;
        const distance = Math.max(1, camera.cameraPosition.distanceTo(target));
        const eye = {
            x: target.x + standard.direction.x * distance,
            y: target.y + standard.direction.y * distance,
            z: target.z + standard.direction.z * distance,
        };
        camera.lookAt(eye, target, standard.up);
        view.update();
        return ok(`-> ${standard.name}`);
    },
};

const UNDO: ConsoleCommand = {
    name: "undo",
    kind: "mutation",
    description: "Undoes the last change of the document.",
    syntax: "UNDO",
    run: (_args, { document }) => {
        if (document === undefined) return fail("No document is open.");
        document.history.undo();
        return ok("-> OK");
    },
};

const REDO: ConsoleCommand = {
    name: "redo",
    kind: "mutation",
    description: "Redoes the change last undone.",
    syntax: "REDO",
    run: (_args, { document }) => {
        if (document === undefined) return fail("No document is open.");
        document.history.redo();
        return ok("-> OK");
    },
};

function formatValue(
    document: IDocument | undefined,
    value: number,
    unit: { length: number; angle: number },
): string {
    if (document !== undefined && unitSpecEquals(unit, LENGTH_UNITS))
        return formatDocumentValue(value, document, LENGTH_UNITS);
    if (document !== undefined && unitSpecEquals(unit, ANGLE_UNITS))
        return formatDocumentValue(value, document, ANGLE_UNITS);
    const text = Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
    if (unitSpecEquals(unit, UNITLESS)) return text;
    return `${text} (length^${unit.length}·angle^${unit.angle})`;
}

export class ConsoleEngine {
    private readonly entries: ConsoleEntry[] = [];
    private readonly listeners = new Set<() => void>();
    /** Whether typed lines are kept in the history (RECORD OFF for throwaway tests). */
    recording = true;

    constructor(readonly app: IApplication) {}

    get history(): readonly ConsoleEntry[] {
        return this.entries;
    }

    onChanged(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }

    private readonly builtins: ConsoleCommand[] = [
        HELP,
        LOOKUP,
        SELECT,
        SET,
        VIEW,
        UNDO,
        REDO,
        {
            name: "history",
            kind: "query",
            description:
                "Shows the lines run in this session, saves them as a script file, or clears them. Lines that changed the document are the ones worth keeping.",
            syntax: "HISTORY [save | clear]",
            examples: ["HISTORY", "HISTORY save"],
            run: (args) => {
                const action = args[0]?.toLowerCase();
                if (action === "clear") {
                    this.entries.length = 0;
                    this.notify();
                    return { ...ok("-> Cleared"), keep: false };
                }
                if (action === "save") {
                    download([this.script()], "chili3d-console.txt");
                    return ok(`-> Saved ${this.entries.length} line(s)`);
                }
                return {
                    lines: [`-> ${this.entries.length} line(s)`],
                    table: {
                        columns: ["#", "Time", "Command", "Result"],
                        rows: this.entries.map((entry, i) => [
                            String(i + 1),
                            entry.time,
                            entry.input,
                            entry.result.error ?? entry.result.lines[0] ?? "",
                        ]),
                    },
                };
            },
        },
        {
            name: "record",
            kind: "query",
            description:
                "Turns the history on or off: ON keeps every line for the script, OFF runs lines imperatively without keeping them (quick tests, measurements).",
            syntax: "RECORD [on | off]",
            examples: ["RECORD off", "RECORD on"],
            run: (args) => {
                const mode = args[0]?.toLowerCase();
                if (mode === "on") this.recording = true;
                else if (mode === "off") this.recording = false;
                else if (mode !== undefined) return fail("Use RECORD on or RECORD off.");
                return ok(`-> Recording ${this.recording ? "on" : "off"}`);
            },
        },
    ];

    /** The console's commands followed by the application's tools, by key. */
    commands(): ConsoleCommand[] {
        const tools = CommandStore.getAllCommands()
            .filter((data) => !data.isApplicationCommand)
            .map((data) => this.toolCommand(data.key));
        return [...this.builtins, ...tools];
    }

    private toolCommand(key: CommandKeys): ConsoleCommand {
        const name = I18n.translate(`command.${key}` as I18nKeys);
        return {
            name: key,
            kind: "app",
            description: `${name}: starts the ${name} tool, which then asks for its picks and values like it does from the ribbon.`,
            syntax: key.toUpperCase(),
            examples: [key.toUpperCase()],
            run: () => {
                PubSub.default.pub("executeCommand", key);
                return ok(`-> ${name}`);
            },
        };
    }

    /** The command a first word names: a console command, a tool key, or a tool's displayed name. */
    find(word: string): ConsoleCommand | undefined {
        const lower = word.toLowerCase();
        const all = this.commands();
        return (
            all.find((command) => command.name.toLowerCase() === lower) ??
            all.find((command) => command.name.split(".").at(-1)?.toLowerCase() === lower) ??
            all.find(
                (command) =>
                    command.kind === "app" &&
                    I18n.translate(`command.${command.name}` as I18nKeys).toLowerCase() === lower,
            )
        );
    }

    /** Commands matching the typed first word, console commands first, by name then description. */
    suggest(input: string, limit = 8): ConsoleSuggestion[] {
        const word = tokenize(input)[0]?.toLowerCase() ?? "";
        if (word === "" || input.trimStart().startsWith("=")) return [];
        const typedMore = /\s$/.test(input) || tokenize(input).length > 1;
        const all = this.commands();
        // The command is complete and its arguments are being typed: the explanation shows it.
        if (typedMore && this.find(word) !== undefined) return [];
        const score = (command: ConsoleCommand) => {
            const name = command.name.toLowerCase();
            const leaf = name.split(".").at(-1) ?? name;
            const display =
                command.kind === "app"
                    ? I18n.translate(`command.${command.name}` as I18nKeys).toLowerCase()
                    : name;
            if (name === word || leaf === word || display === word) return 0;
            if (name.startsWith(word) || leaf.startsWith(word) || display.startsWith(word)) return 1;
            if (!typedMore && (name.includes(word) || display.includes(word))) return 2;
            if (!typedMore && command.description.toLowerCase().includes(word)) return 3;
            return undefined;
        };
        return all
            .map((command) => ({ command, rank: score(command) }))
            .filter((item): item is { command: ConsoleCommand; rank: number } => item.rank !== undefined)
            .sort(
                (a, b) =>
                    a.rank - b.rank ||
                    (a.command.kind === "app" ? 1 : 0) - (b.command.kind === "app" ? 1 : 0),
            )
            .slice(0, limit)
            .map(({ command }) => ({ command, insert: `${command.name.toUpperCase()} ` }));
    }

    /** The value of a bare expression (`= 2 * 3 in` or just `2 * 3 in`), when the line is one. */
    preview(input: string): string | undefined {
        const document = this.app.activeView?.document;
        const text = input.trim().replace(/^=\s*/, "");
        if (text === "" || document === undefined) return undefined;
        if (this.find(tokenize(text)[0] ?? "") !== undefined && !input.trimStart().startsWith("="))
            return undefined;
        const evaluated = evaluateExpression(text, document.variables.scope);
        if (!evaluated.isOk) return undefined;
        return `= ${formatValue(document, evaluated.value.value, evaluated.value.unit)}`;
    }

    /** Runs one line; the entry is kept in the history (while recording) and returned. */
    async run(input: string): Promise<ConsoleEntry> {
        const line = input.trim();
        // Whether this line is kept is decided before it runs: "RECORD off" itself is kept.
        const keep = this.recording;
        const context: ConsoleContext = { app: this.app, document: this.app.activeView?.document };
        const tokens = tokenize(line.replace(/^=\s*/, ""));
        const first = tokens[0] ?? "";
        let result: ConsoleResult;
        let kind: ConsoleEntry["kind"] = "expression";
        const command = line.startsWith("=") ? undefined : this.find(first);
        if (line === "") result = ok();
        else if (command?.name === "help") result = this.help(tokens.slice(1));
        else if (command !== undefined) {
            kind = command.kind;
            try {
                result = await command.run(tokens.slice(1), context);
            } catch (error) {
                result = fail(error instanceof Error ? error.message : String(error));
            }
        } else {
            const preview = this.preview(line);
            result =
                preview === undefined
                    ? fail(
                          `Unknown command "${first}". Type HELP for the list, or an expression such as 2 * 3 in.`,
                      )
                    : ok(`-> ${preview.slice(2)}`);
        }
        const entry: ConsoleEntry = { time: timeOf(new Date()), input: line, result, kind };
        if ((keep && result.keep !== false) || result.error !== undefined) this.entries.push(entry);
        this.notify();
        return entry;
    }

    private help(args: readonly string[]): ConsoleResult {
        if (args.length === 0) {
            const commands = this.builtins;
            return {
                lines: [
                    `-> ${commands.length} console commands; any tool by its key (e.g. ${CommandStore.getAllCommands()[0]?.key ?? "doc.save"})`,
                ],
                table: {
                    columns: ["Command", "Syntax", "Description"],
                    rows: commands.map((command) => [
                        command.name.toUpperCase(),
                        command.syntax,
                        command.description,
                    ]),
                },
            };
        }
        const command = this.find(args[0]);
        if (command === undefined) return fail(`No command "${args[0]}".`);
        return ok(
            `${command.name.toUpperCase()}: ${command.description}`,
            `Syntax: ${command.syntax}`,
            ...(command.examples ?? []).map((example) => `  ${example}`),
        );
    }

    /** The recorded lines as a script: one command per line, results as comments. */
    script(): string {
        return this.entries
            .map(
                (entry) =>
                    `${entry.input}\n; ${entry.time} ${entry.result.error ?? entry.result.lines.join(" | ")}`,
            )
            .join("\n");
    }

    private notify() {
        for (const listener of this.listeners) listener();
    }
}
