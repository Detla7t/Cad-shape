// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { I18nKeys } from "@chili3d/core";
import { createElement, div } from "@chili3d/element";
import { nextToolId, nextToolNumber, setupTools } from "../context/tools";
import { resolveMachine } from "../machines";
import { TOOL_KINDS } from "../machines/profileJson";
import type { SetupData } from "../model/setup";
import type { ToolCuttingData, ToolData, ToolKind } from "../model/tool";
import style from "./camStudio.module.css";
import { numberField, row, section, selectField, t, textButton, textField } from "./dom";
import { putSetupTool, removeSetupTool } from "./studioEdits";
import type { StudioHost } from "./studioHost";

/**
 * The setup's tool library: the machine's tools and the setup's own. A setup tool is
 * edited in place; editing a machine tool writes a setup copy with its id, which overrides
 * it for this setup only (the profile stays as it is).
 */

const table = createElement("table");
const thead = createElement("thead");
const tbody = createElement("tbody");
const tr = createElement("tr");
const th = createElement("th");
const td = createElement("td");

const kindLabel = (kind: ToolKind) =>
    kind.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

const COOLANTS: readonly NonNullable<ToolCuttingData["coolant"]>[] = [
    "off",
    "flood",
    "mist",
    "air",
    "throughTool",
];

export function renderToolsPanel(host: StudioHost, setup: SetupData): HTMLElement {
    const machine = resolveMachine(host.studio, setup.machineId)?.profile;
    if (machine === undefined)
        return div({ className: style.error, textContent: `Unknown machine "${setup.machineId}"` });
    const tools = setupTools(setup, machine);
    const own = new Set((setup.tools ?? []).map((tool) => tool.id));
    const machineIds = new Set((machine.tools ?? []).map((tool) => tool.id));
    const selected = tools.find((tool) => tool.id === host.state.toolId) ?? tools[0];

    const body = tbody({});
    for (const tool of tools) {
        const line = tr(
            {},
            td({ textContent: `T${tool.number}` }),
            td({ textContent: tool.name }),
            td({ textContent: kindLabel(tool.kind) }),
            td({ textContent: `Ø${Number(tool.diameter.toFixed(3))}` }),
            td({ textContent: own.has(tool.id) ? (machineIds.has(tool.id) ? "✎" : "+") : "" }),
        );
        if (tool.id === selected?.id) line.dataset["selected"] = "";
        line.dataset["tool"] = tool.id;
        line.addEventListener("click", () => host.select({ toolId: tool.id }));
        body.append(line);
    }
    const list = table(
        { className: style.table },
        thead(
            {},
            tr(
                {},
                th({ textContent: "T" }),
                th({ textContent: t("cam.name") }),
                th({ textContent: t("cam.tool.kind") }),
                th({ textContent: "Ø" }),
                th({ textContent: "" }),
            ),
        ),
        body,
    );
    const actions = div(
        { className: style.buttons },
        textButton(
            t("cam.addTool"),
            () => {
                const id = nextToolId(tools);
                const tool: ToolData = {
                    id,
                    number: nextToolNumber(tools),
                    name: `Tool ${tools.length + 1}`,
                    kind:
                        machine.kind === "mill"
                            ? "flatEndmill"
                            : machine.kind === "wireEdm"
                              ? "wire"
                              : machine.kind === "printer"
                                ? "nozzle"
                                : "jet",
                    diameter:
                        machine.kind === "mill"
                            ? 6
                            : (machine.cutting?.kerf ?? machine.wire?.wireDiameter ?? 1),
                    cutting: {
                        feed: 1000,
                        ...(machine.kind === "mill" ? { spindleRpm: 10000, plungeFeed: 300 } : {}),
                    },
                };
                host.state.toolId = id;
                host.commitSetup("add tool", putSetupTool(setup, tool));
            },
            false,
            "add-tool",
        ),
    );
    const element = div({}, list, actions);
    if (selected !== undefined)
        element.append(toolForm(host, setup, selected, own.has(selected.id), machineIds.has(selected.id)));
    return element;
}

function toolForm(
    host: StudioHost,
    setup: SetupData,
    tool: ToolData,
    own: boolean,
    fromMachine: boolean,
): HTMLElement {
    const write = (name: string, next: ToolData) => host.commitSetup(name, putSetupTool(setup, next));
    const num = (key: keyof ToolData, labelKey: I18nKeys, unit?: string, integer = false) =>
        row(
            t(labelKey),
            numberField(
                `tool.${String(key)}`,
                tool[key] as number | undefined,
                (value) => {
                    const next = { ...tool } as Record<string, unknown>;
                    if (value === undefined) delete next[key as string];
                    else next[key as string] = value;
                    write("edit tool", next as unknown as ToolData);
                },
                { optional: key !== "diameter" && key !== "number", min: 0, integer },
            ),
            unit,
        );
    const cut = (key: keyof ToolCuttingData, labelKey: I18nKeys, unit?: string) =>
        row(
            t(labelKey),
            numberField(
                `tool.cutting.${key}`,
                tool.cutting[key] as number | undefined,
                (value) => {
                    const cutting = { ...tool.cutting } as Record<string, unknown>;
                    if (value === undefined && key !== "feed") delete cutting[key];
                    else cutting[key] = value ?? tool.cutting.feed;
                    write("edit tool", { ...tool, cutting: cutting as unknown as ToolCuttingData });
                },
                { optional: key !== "feed", min: 0 },
            ),
            unit,
        );
    const holder = tool.holder;
    return section(
        `T${tool.number} ${tool.name}`,
        ...(fromMachine && !own ? [div({ className: style.note, textContent: t("cam.tool.machine") })] : []),
        num("number", "cam.tool.number", undefined, true),
        row(
            t("cam.name"),
            textField("tool.name", tool.name, (name) => write("rename tool", { ...tool, name })),
        ),
        row(
            t("cam.tool.kind"),
            selectField(
                "tool.kind",
                TOOL_KINDS.map((kind) => ({ value: kind, label: kindLabel(kind) })),
                tool.kind,
                (kind) => write("tool kind", { ...tool, kind: kind as ToolKind }),
            ),
        ),
        num("diameter", "cam.tool.diameter", "mm"),
        num("cornerRadius", "cam.tool.cornerRadius", "mm"),
        num("tipAngle", "cam.tool.tipAngle", "°"),
        num("fluteLength", "cam.tool.fluteLength", "mm"),
        num("overallLength", "cam.tool.overallLength", "mm"),
        num("stickout", "cam.tool.stickout", "mm"),
        num("flutes", "cam.tool.flutes", undefined, true),
        num("pitch", "cam.tool.pitch", "mm"),
        row(
            t("cam.tool.holder"),
            div(
                { className: style.vector },
                numberField(
                    "tool.holder.d",
                    holder?.diameter,
                    (diameter) =>
                        write(
                            "tool holder",
                            diameter === undefined
                                ? withoutHolder(tool)
                                : { ...tool, holder: { diameter, length: holder?.length ?? 40 } },
                        ),
                    { optional: true, min: 0 },
                ),
                numberField(
                    "tool.holder.l",
                    holder?.length,
                    (length) =>
                        write(
                            "tool holder",
                            length === undefined
                                ? withoutHolder(tool)
                                : { ...tool, holder: { diameter: holder?.diameter ?? 30, length } },
                        ),
                    { optional: true, min: 0 },
                ),
            ),
            "mm",
        ),
        cut("spindleRpm", "cam.tool.rpm"),
        cut("feed", "cam.tool.feed", "mm/min"),
        cut("plungeFeed", "cam.tool.plungeFeed", "mm/min"),
        cut("rampFeed", "cam.tool.rampFeed", "mm/min"),
        cut("stepdown", "cam.tool.stepdown", "mm"),
        cut("stepover", "cam.tool.stepover", "mm"),
        row(
            t("cam.tool.coolant"),
            selectField(
                "tool.coolant",
                COOLANTS.map((value) => ({ value, label: value })),
                tool.cutting.coolant ?? "off",
                (coolant) =>
                    write("tool coolant", {
                        ...tool,
                        cutting: { ...tool.cutting, coolant: coolant as ToolCuttingData["coolant"] },
                    }),
            ),
        ),
        div(
            { className: style.buttons },
            ...(own
                ? [
                      textButton(
                          fromMachine ? t("cam.tool.reset") : t("cam.delete"),
                          () => {
                              host.state.toolId = undefined;
                              host.commitSetup(
                                  fromMachine ? "reset tool" : "delete tool",
                                  removeSetupTool(setup, tool.id),
                              );
                          },
                          false,
                          "delete-tool",
                      ),
                  ]
                : []),
        ),
    );
}

function withoutHolder(tool: ToolData): ToolData {
    const { holder: _holder, ...rest } = tool;
    return rest;
}
