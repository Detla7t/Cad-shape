// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ComponentContext,
    Config,
    GeometryNode,
    I18n,
    type I18nKeys,
    type IApplication,
    type IDocument,
    type INode,
    type INodeLinkedList,
    isFeatureListNode,
    isNodeIcon,
    NodeEvaluation,
    PartStudioTimeline,
    type PartStudioTimelineEntry,
    PubSub,
    type TimelineGroup,
    type TimelineLanes,
    timelineLanes,
} from "@chili3d/core";
import {
    LiveEvaluationIndicator,
    mountIsland,
    type ReactIsland,
    useActiveDocument,
    useObservable,
} from "@chili3d/react";
import {
    type CSSProperties,
    type KeyboardEvent,
    type MouseEvent,
    type PointerEvent,
    type ReactNode,
    type RefObject,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { showFeatureContextMenu } from "../../property/featureContextMenu";
import { featureDisplayName } from "../../property/featureName";
import { showNodeContextMenu } from "../nodeContextMenu";
import { computeOwnership, OWNER_PALETTE, type Ownership } from "../tree/ownerColors";
import { canSelectNodes } from "../treeSelection";
import { createTypeIcon } from "../typeIcon";
import style from "./partStudioTimelineBar.module.css";

/**
 * Fusion 360's timeline under the viewport: every step of the Part Studio, oldest on the left,
 * with a marker that rolls the model back. It is a view of `PartStudioTimeline` — the same
 * model the feature tree's history bars read and drive, so moving any marker moves them all.
 *
 * Along the band's top edge run the part bars: one continuous bar in a part's colour over its
 * run of steps, broken where another part's step comes in (a step no part reads has none). A step another part relies on (a shared
 * sketch, a tool body) carries that part's thinner bar stacked above its own — three bars at
 * most; past that a cross-hatched bar stands for all of them, and clicking it lists the parts.
 * Steps can be picked (click, Ctrl, Shift for a range) and grouped into one chip
 * (`PartStudioTimeline.group`), which opens with the +/− on the rail under it and renames with
 * a double-click. A drag on a step or a group's head reorders the timeline: the other steps
 * shift aside as it moves and the document follows on release (`PartStudioTimeline.move`).
 * With a component active (a folder, Fusion's components), only its steps show and a control
 * at the left goes back to the parent.
 */

const t = (key: I18nKeys, ...args: unknown[]) => I18n.translate(key, ...args);
const join = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

/** Bar colours of parts without a colour of their own, by first appearance on the timeline. */
export const PART_COLORS = [
    "#3a86e8",
    "#2faa6a",
    "#e8833a",
    "#c94fa0",
    "#8f6be0",
    "#d9a400",
    "#2ab1c9",
    "#d85a5a",
] as const;

/** Bars stacked on one step at most; more parts show as one cross-hatched bar. */
export const MAX_LANES = 3;

/** The persisted "Show timeline" preference (Config ▸ preferences.showTimeline). */
export function useShowTimeline(): boolean {
    const subscribe = useCallback((notify: () => void) => {
        const handler = (property: keyof Config) => {
            if (property === "preferences") notify();
        };
        Config.instance.onPropertyChanged(handler);
        return () => Config.instance.removePropertyChanged(handler);
    }, []);
    const read = () => Config.instance.preferences.showTimeline;
    return useSyncExternalStore(subscribe, read, read);
}

export function setShowTimeline(show: boolean): void {
    Config.instance.preferences = { ...Config.instance.preferences, showTimeline: show };
    Config.instance.saveToStorage();
}

/** The timeline of the active document, while the preference shows it. */
export function PartStudioTimelineBar() {
    const document = useActiveDocument();
    const shown = useShowTimeline();
    if (document === undefined || !shown) return null;
    return <TimelineBar document={document} />;
}

/** Mounts the timeline into the legacy shell (under the Part Studio viewport). */
export function mountPartStudioTimeline(host: Element, application: IApplication): ReactIsland {
    return mountIsland(host, <PartStudioTimelineBar />, application);
}

export interface TimelineBarProps {
    readonly document: IDocument;
    /** Milliseconds between steps while playing. */
    readonly playInterval?: number;
}

/** A CSS colour for a material colour (0xrrggbb or a CSS string). */
function cssColor(color: number | string): string {
    return typeof color === "number" ? `#${color.toString(16).padStart(6, "0")}` : color;
}

/**
 * The parts behind a step as the Features tree colours them (`computeOwnership`): a result —
 * a sketch, a body — owns itself and what it reads, so a step's first bar is its own node's
 * colour and the others are the parts relying on it, in the tree's palette. The two views
 * then match colour for colour. With the tree's colouring off, the timeline falls back to
 * `timelineLanes` and its own palette.
 */
export function ownershipLanes(
    ownership: Ownership,
    entries: readonly PartStudioTimelineEntry[],
): { lanes: TimelineLanes[]; colors: Map<INode, string> } | undefined {
    if (ownership.owners.length === 0) return undefined;
    const colors = new Map<INode, string>();
    ownership.owners.forEach((owner, index) =>
        colors.set(owner, OWNER_PALETTE[index % OWNER_PALETTE.length]),
    );
    const lanes = entries.map((entry) => {
        const owners = (ownership.ownersOf.get(entry.node.id) ?? []).map((index) => ownership.owners[index]);
        return { owner: owners[0], users: owners.slice(1) };
    });
    return { lanes, colors };
}

/**
 * The bar colour of every part: its material's colour when that is not the document's default
 * material colour (every part looks the same otherwise), else the palette by first appearance.
 */
export function partColors(document: IDocument, lanes: readonly TimelineLanes[]): Map<INode, string> {
    const colors = new Map<INode, string>();
    const materials = document.modelManager.materials;
    const defaultColor = materials.at(0)?.color;
    const ownColor = (part: INode) => {
        if (!(part instanceof GeometryNode)) return undefined;
        const id = Array.isArray(part.materialId) ? part.materialId[0] : part.materialId;
        const material = typeof id === "string" ? materials.find((item) => item.id === id) : undefined;
        if (material === undefined || material.color === defaultColor) return undefined;
        return cssColor(material.color);
    };
    let next = 0;
    const assign = (part: INode) => {
        if (colors.has(part)) return;
        colors.set(part, ownColor(part) ?? PART_COLORS[next++ % PART_COLORS.length]);
    };
    for (const lane of lanes) {
        if (lane.owner !== undefined) assign(lane.owner);
        for (const user of lane.users) assign(user);
    }
    return colors;
}

interface GroupSpan {
    readonly first: number;
    readonly last: number;
    readonly count: number;
}

/** A visible item of the track: a step (one key) or a group's head (its keys). */
interface TrackSlot {
    readonly keys: readonly string[];
    readonly entryIndex: number;
}

interface PendingDrag {
    readonly keys: readonly string[];
    readonly slot: number;
    readonly startX: number;
    rects: { left: number; width: number }[] | undefined;
}

export interface DragState {
    readonly keys: readonly string[];
    /** The first dragged slot and how many slots the block spans. */
    readonly from: number;
    readonly count: number;
    /** Where the block lands, counted among the slots without it. */
    readonly to: number;
    readonly dx: number;
    readonly width: number;
}

/** How far a slot moves aside (or the dragged block follows the pointer) during a drag. */
export function dragShift(drag: DragState | undefined, slot: number): number {
    if (drag === undefined) return 0;
    if (slot >= drag.from && slot < drag.from + drag.count) return drag.dx;
    const rest = slot < drag.from ? slot : slot - drag.count;
    if (drag.to <= rest && rest < drag.from) return drag.width;
    if (drag.from <= rest && rest < drag.to) return -drag.width;
    return 0;
}

function within(node: INode | undefined, container: INode): boolean {
    for (let current = node; current !== undefined; current = current.parent) {
        if (current === container) return true;
    }
    return false;
}

export function TimelineBar({ document, playInterval = 400 }: TimelineBarProps) {
    const timeline = useMemo(() => PartStudioTimeline.of(document), [document]);
    const entries = useObservable(timeline, "entries");
    const position = useObservable(timeline, "position");
    const groups = useObservable(timeline, "groups");
    const [preview, setPreview] = useState<number | undefined>();
    const shown = preview ?? position;
    const selected = useSelectedNodes(document);
    const { lanes, colors } = useMemo(() => {
        const mode = Config.instance.preferences.treeOwnerColors;
        const owned = mode === "off" ? undefined : ownershipLanes(computeOwnership(document, mode), entries);
        if (owned !== undefined) return owned;
        const fallback = timelineLanes(entries);
        return { lanes: fallback, colors: partColors(document, fallback) };
    }, [document, entries]);
    const evaluations = useMemo(() => new Map<INode, NodeEvaluation>(), [document]);
    const evaluationOf = (node: INode) => {
        let evaluation = evaluations.get(node);
        if (evaluation === undefined) {
            evaluation = new NodeEvaluation(node, (item) =>
                isFeatureListNode(node) ? featureDisplayName(document, node, item) : t(item.display),
            );
            evaluations.set(node, evaluation);
        }
        return evaluation;
    };

    // Picked steps (the timeline's own selection, for grouping and Shift ranges).
    const [picked, setPicked] = useState<readonly string[]>([]);
    const anchor = useRef<string | undefined>(undefined);
    useEffect(() => {
        const keys = new Set(entries.map((entry) => entry.key));
        setPicked((current) =>
            current.every((key) => keys.has(key)) ? current : current.filter((key) => keys.has(key)),
        );
    }, [entries]);
    const nodeOf = (key: string) => entries.find((entry) => entry.key === key)?.node;
    useEffect(() => {
        // The selection moved on elsewhere (the tree, the viewport): picked steps follow it.
        setPicked((current) => {
            const kept = current.filter((key) => {
                const node = nodeOf(key);
                return node !== undefined && selected.includes(node);
            });
            return kept.length === current.length ? current : kept;
        });
        // biome-ignore lint/correctness/useExhaustiveDependencies: nodeOf reads the current entries
    }, [selected]);
    const pick = (index: number, event: MouseEvent) => {
        const key = entries[index].key;
        let next: string[];
        if (event.shiftKey && anchor.current !== undefined) {
            const from = entries.findIndex((entry) => entry.key === anchor.current);
            const [a, b] = from < 0 ? [index, index] : [Math.min(from, index), Math.max(from, index)];
            next = entries.slice(a, b + 1).map((entry) => entry.key);
        } else if (event.ctrlKey || event.metaKey) {
            next = picked.includes(key) ? picked.filter((item) => item !== key) : [...picked, key];
            anchor.current = key;
        } else {
            next = [key];
            anchor.current = key;
        }
        setPicked(next);
        if (!canSelectNodes(document)) return;
        const nodes = [...new Set(next.map(nodeOf).filter((node): node is INode => node !== undefined))];
        document.selection.setSelectedNodes(nodes, false);
    };

    // Popovers: the parts behind a cross-hatched bar, a group's menu.
    const [shared, setShared] = useState<{ index: number; x: number; y: number } | undefined>();
    const [menu, setMenu] = useState<{ group: TimelineGroup; x: number; y: number } | undefined>();
    const [renaming, setRenaming] = useState<string | undefined>();

    // The active component (a folder, Fusion's activated component): only its steps show.
    const scoped = useActiveComponent(document);
    const root = document.modelManager.rootNode;
    const inContext = (node: INode) => scoped === undefined || within(node, scoped);

    // A drag on a step or a group's head: the block follows the pointer, the others shift aside.
    const [dragging, setDragging] = useState<DragState | undefined>();
    const suppressClick = useRef(false);
    const dragRef = useRef<PendingDrag | undefined>(undefined);
    // The window's pointer handlers were made by the render the press happened in: they read refs.
    const dragStateRef = useRef<DragState | undefined>(undefined);
    const entriesRef = useRef(entries);
    entriesRef.current = entries;

    const [playing, setPlaying] = usePlayback(timeline, playInterval);
    const scroller = useRef<HTMLDivElement>(null);
    const marker = useRef<HTMLDivElement>(null);
    useKeepInView(scroller, marker, shown, entries);
    // The marker moves between the steps in the DOM; keyboard and drag keep it focused.
    const keepFocus = useRef(false);
    useLayoutEffect(() => {
        if (keepFocus.current && globalThis.document.activeElement !== marker.current)
            marker.current?.focus();
    }, [shown]);

    const drag = useMarkerDrag(timeline, scroller, setPreview);
    const onMarkerKey = (event: KeyboardEvent) => {
        let target = timeline.position;
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") target--;
        else if (event.key === "ArrowRight" || event.key === "ArrowDown") target++;
        else if (event.key === "Home") target = 0;
        else if (event.key === "End") target = timeline.length;
        else return;
        event.preventDefault();
        event.stopPropagation();
        keepFocus.current = true;
        timeline.rollTo(target);
    };

    const labelOf = (entry: PartStudioTimelineEntry) =>
        entry.kind === "feature" ? featureDisplayName(document, entry.node, entry.feature) : entry.node.name;
    const markerText =
        shown >= entries.length
            ? t("timeline.markerEnd")
            : t("timeline.markerBefore{0}", labelOf(entries[shown]));

    const markerElement = (
        <div
            key="marker"
            ref={marker}
            className={join(style.marker, preview !== undefined && style.dragging)}
            role="slider"
            tabIndex={0}
            aria-label={t("timeline.marker")}
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={entries.length}
            aria-valuenow={shown}
            aria-valuetext={markerText}
            title={markerText}
            onPointerDown={(event) => {
                keepFocus.current = true;
                drag(event);
            }}
            onBlur={(event) => {
                // Focus moved elsewhere (not a DOM move of the marker itself).
                if (event.relatedTarget !== null) keepFocus.current = false;
            }}
            onKeyDown={onMarkerKey}
            onDoubleClick={(event) => {
                event.stopPropagation();
                timeline.end();
            }}
        />
    );

    // Groups: where each one starts and ends on the timeline; a collapsed group hides its steps
    // unless the marker is inside it.
    const groupByKey = useMemo(() => {
        const map = new Map<string, TimelineGroup>();
        for (const group of groups) for (const key of group.keys) map.set(key, group);
        return map;
    }, [groups]);
    const spans = useMemo(() => {
        const map = new Map<string, GroupSpan>();
        entries.forEach((entry, index) => {
            const group = groupByKey.get(entry.key);
            if (group === undefined) return;
            const span = map.get(group.id);
            map.set(
                group.id,
                span === undefined
                    ? { first: index, last: index, count: 1 }
                    : { first: span.first, last: index, count: span.count + 1 },
            );
        });
        return map;
    }, [entries, groupByKey]);
    const isOpen = (group: TimelineGroup, span: GroupSpan) =>
        !group.collapsed || (span.first < shown && shown <= span.last);
    const visible = entries.map((entry) => {
        if (!inContext(entry.node)) return false;
        const group = groupByKey.get(entry.key);
        return group === undefined || isOpen(group, spans.get(group.id)!);
    });
    const previousVisible = (index: number) => {
        for (let i = index - 1; i >= 0; i--) if (visible[i]) return i;
        return -1;
    };
    const nextVisible = (index: number) => {
        for (let i = index + 1; i < entries.length; i++) if (visible[i]) return i;
        return -1;
    };
    const sameOwner = (a: number, b: number) =>
        a >= 0 && b >= 0 && lanes[a].owner !== undefined && lanes[a].owner === lanes[b].owner;
    const titleOf = (index: number, label: string) => {
        const lines = [index >= shown ? `${label} (${t("timeline.rolledBack")})` : label];
        const { owner, users } = lanes[index];
        if (owner !== undefined) lines.push(t("timeline.partOf{0}", owner.name));
        if (users.length > 0) lines.push(t("timeline.usedBy{0}", users.map((part) => part.name).join(", ")));
        return lines.join("\n");
    };

    // The visible items in track order (a step or a group's head), with the entry each stands at.
    const slots: TrackSlot[] = [];
    const slotOf = (keys: readonly string[], entryIndex: number) => {
        slots.push({ keys, entryIndex });
        return slots.length - 1;
    };
    const shiftOf = (slot: number) => dragShift(dragging, slot);
    const isDragged = (slot: number) =>
        dragging !== undefined && slot >= dragging.from && slot < dragging.from + dragging.count;
    const beginDrag = (keys: readonly string[], slot: number, event: PointerEvent<HTMLElement>) => {
        if (event.button !== 0 || dragging !== undefined) return;
        if ((event.target as Element).closest("[data-shared]") !== null) return;
        dragRef.current = { keys, slot, startX: event.clientX, rects: undefined };
        window.addEventListener("pointermove", onDragMove);
        window.addEventListener("pointerup", onDragEnd);
        window.addEventListener("pointercancel", onDragCancel);
    };

    const track: ReactNode[] = [];
    entries.forEach((entry, index) => {
        if (index === shown && inContext(entry.node)) track.push(markerElement);
        const group = groupByKey.get(entry.key);
        const span = group === undefined ? undefined : spans.get(group.id);
        if (group !== undefined && span !== undefined && inContext(entry.node)) {
            const open = isOpen(group, span);
            if (index === span.first) {
                const slot = slotOf(group.keys, index);
                track.push(
                    <GroupChip
                        key={`group:${group.id}`}
                        group={group}
                        open={open}
                        count={span.count}
                        future={span.first >= shown}
                        renaming={renaming === group.id}
                        shift={shiftOf(slot)}
                        dragged={isDragged(slot)}
                        onToggle={() => timeline.setGroupCollapsed(group.id, !group.collapsed)}
                        onRename={() => setRenaming(group.id)}
                        onRenamed={(name) => {
                            setRenaming(undefined);
                            if (name !== undefined) timeline.renameGroup(group.id, name);
                        }}
                        onMenu={(event) => setMenu({ group, x: event.clientX, y: event.clientY })}
                        onDragStart={(event) => beginDrag(group.keys, slot, event)}
                        suppressClick={suppressClick}
                    />,
                );
            }
            if (!open) return;
        }
        if (!visible[index]) return;
        const label = labelOf(entry);
        const previous = previousVisible(index);
        const following = nextVisible(index);
        const slot = slotOf([entry.key], index);
        track.push(
            <TimelineStep
                key={entry.key}
                entry={entry}
                label={label}
                title={`${titleOf(index, label)}\n${t("timeline.dragToReorder")}`}
                future={index >= shown}
                selected={selected.includes(entry.node)}
                picked={picked.includes(entry.key)}
                lanes={lanes[index]}
                colors={colors}
                shift={shiftOf(slot)}
                dragged={isDragged(slot)}
                onDragStart={(event) => beginDrag([entry.key], slot, event)}
                joinLeft={sameOwner(previous, index)}
                joinRight={sameOwner(index, following)}
                grouped={
                    group === undefined || span === undefined
                        ? undefined
                        : span.first === span.last
                          ? "only"
                          : index === span.first
                            ? "start"
                            : index === span.last
                              ? "end"
                              : "middle"
                }
                evaluation={evaluationOf(entry.node)}
                onSelect={(event) => {
                    if (suppressClick.current) {
                        suppressClick.current = false;
                        return;
                    }
                    pick(index, event);
                }}
                onShared={(event) => setShared({ index, x: event.clientX, y: event.clientY })}
                onOpen={() => {
                    // the marker follows the opened step: the model with it just applied
                    timeline.rollAfter(entry.node, entry.kind === "feature" ? entry.feature.id : undefined);
                    if (entry.kind === "feature")
                        PubSub.default.pub("editFeature", entry.node, entry.feature.id);
                    else PubSub.default.pub("nodeDoubleClicked", entry.node);
                }}
                onMenu={(event) => {
                    if (entry.kind === "feature")
                        showFeatureContextMenu(document, entry.node, entry.feature, {
                            x: event.clientX,
                            y: event.clientY,
                        });
                    else showNodeContextMenu(entry.node, event.clientX, event.clientY);
                }}
            />,
        );
    });
    if (shown >= entries.length || !track.includes(markerElement)) track.push(markerElement);

    // The drag's pointer handlers read the slots of the render they started in.
    const slotsRef = useRef(slots);
    slotsRef.current = slots;
    const onDragMove = (event: globalThis.PointerEvent) => {
        const pending = dragRef.current;
        if (pending === undefined) return;
        const dx = event.clientX - pending.startX;
        if (pending.rects === undefined) {
            if (Math.abs(dx) < 4) return;
            const elements = scroller.current?.querySelectorAll<HTMLElement>("[data-slot]") ?? [];
            pending.rects = [...elements].map((element) => {
                const rect = element.getBoundingClientRect();
                return { left: rect.left, width: rect.width + 2 };
            });
            suppressClick.current = true;
        }
        const rects = pending.rects;
        const count = slotsRef.current.filter(
            (slot, i) => i >= pending.slot && pending.keys.includes(slot.keys[0]),
        ).length;
        const width = rects
            .slice(pending.slot, pending.slot + count)
            .reduce((sum, rect) => sum + rect.width, 0);
        const rest = rects.filter((_, i) => i < pending.slot || i >= pending.slot + count);
        let to = 0;
        for (const rect of rest)
            if (event.clientX > rect.left + rect.width / 2 + (to >= pending.slot ? -width : 0)) to++;
        const state: DragState = { keys: pending.keys, from: pending.slot, count, to, dx, width };
        dragStateRef.current = state;
        setDragging(state);
    };
    const finishDrag = () => {
        window.removeEventListener("pointermove", onDragMove);
        window.removeEventListener("pointerup", onDragEnd);
        window.removeEventListener("pointercancel", onDragCancel);
        dragRef.current = undefined;
        dragStateRef.current = undefined;
        setDragging(undefined);
    };
    const onDragCancel = () => finishDrag();
    const onDragEnd = () => {
        const pending = dragRef.current;
        const state = dragStateRef.current;
        finishDrag();
        if (pending === undefined || pending.rects === undefined || state === undefined) return;
        const all = entriesRef.current;
        const restSlots = slotsRef.current.filter((_, i) => i < state.from || i >= state.from + state.count);
        const target = restSlots[state.to];
        const moved = new Set(state.keys);
        const restEntries = all.filter((entry) => !moved.has(entry.key));
        const to =
            target === undefined
                ? restEntries.length
                : restEntries.filter((entry) => all.indexOf(entry) < target.entryIndex).length;
        if (!timeline.move(state.keys, to)) PubSub.default.pub("displayError", t("timeline.reorderRefused"));
    };

    const atStart = position === 0;
    const atEnd = position >= entries.length;
    return (
        <div
            className={style.bar}
            role="toolbar"
            aria-label={t("timeline.label")}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
        >
            {scoped !== undefined ? (
                <div className={style.context}>
                    <ControlButton
                        label={t(
                            "timeline.backToParent{0}",
                            scoped.parent === root || scoped.parent === undefined
                                ? root.name
                                : scoped.parent.name,
                        )}
                        onClick={() => ComponentContext.activateParent(document)}
                    >
                        <path d="M7 12V3M3 7l4-4 4 4" />
                    </ControlButton>
                    <span className={style.contextName} title={scoped.name}>
                        {scoped.name}
                    </span>
                </div>
            ) : null}
            <div className={style.controls}>
                <ControlButton
                    label={t("timeline.start")}
                    disabled={atStart}
                    onClick={() => timeline.start()}
                >
                    <path d="M3 2v10M12 2 5 7l7 5Z" />
                </ControlButton>
                <ControlButton
                    label={t("timeline.stepBack")}
                    disabled={atStart}
                    onClick={() => timeline.step(-1)}
                >
                    <path d="M2 2v10M11 2 4 7l7 5Z" />
                </ControlButton>
                <ControlButton
                    label={playing ? t("timeline.stop") : t("timeline.play")}
                    pressed={playing}
                    disabled={entries.length === 0}
                    onClick={() => setPlaying(!playing)}
                >
                    {playing ? <path d="M3 3h8v8H3Z" /> : <path d="M4 2v10l8-5Z" />}
                </ControlButton>
                <ControlButton
                    label={t("timeline.stepForward")}
                    disabled={atEnd}
                    onClick={() => timeline.step(1)}
                >
                    <path d="M3 2v10l7-5ZM12 2v10" />
                </ControlButton>
                <ControlButton label={t("timeline.end")} disabled={atEnd} onClick={() => timeline.end()}>
                    <path d="M2 2v10l7-5ZM11 2v10" />
                </ControlButton>
                <ControlButton
                    label={t("timeline.group")}
                    disabled={picked.length === 0}
                    onClick={() => {
                        if (timeline.group(picked) !== undefined) setPicked([]);
                    }}
                >
                    <path d="M1.5 3.5h4l1.5 1.5h5.5v7h-11Z" fill="none" />
                    <path d="M7 6.5v4M5 8.5h4" />
                </ControlButton>
            </div>
            <div
                className={style.track}
                ref={scroller}
                onWheel={(event) => {
                    // A plain wheel scrolls the steps sideways.
                    if (event.deltaX !== 0 || event.deltaY === 0) return;
                    event.currentTarget.scrollLeft += event.deltaY;
                }}
            >
                <div className={style.steps}>{track}</div>
            </div>
            <TimelineSettings />
            {shared !== undefined && shared.index < entries.length ? (
                <SharedParts
                    lanes={lanes[shared.index]}
                    colors={colors}
                    x={shared.x}
                    y={shared.y}
                    onPick={(part) => {
                        setShared(undefined);
                        if (canSelectNodes(document)) document.selection.setSelectedNodes([part], false);
                    }}
                    onClose={() => setShared(undefined)}
                />
            ) : null}
            {menu !== undefined ? (
                <GroupMenu
                    group={menu.group}
                    x={menu.x}
                    y={menu.y}
                    onClose={() => setMenu(undefined)}
                    onRename={() => {
                        setMenu(undefined);
                        setRenaming(menu.group.id);
                    }}
                    onToggle={() => {
                        setMenu(undefined);
                        timeline.setGroupCollapsed(menu.group.id, !menu.group.collapsed);
                    }}
                    onUngroup={() => {
                        setMenu(undefined);
                        timeline.ungroup(menu.group.id);
                    }}
                />
            ) : null}
        </div>
    );
}

interface TimelineStepProps {
    readonly entry: PartStudioTimelineEntry;
    readonly label: string;
    readonly title: string;
    readonly future: boolean;
    readonly selected: boolean;
    readonly picked: boolean;
    readonly lanes: TimelineLanes;
    readonly colors: ReadonlyMap<INode, string>;
    readonly joinLeft: boolean;
    readonly joinRight: boolean;
    readonly grouped: "start" | "middle" | "end" | "only" | undefined;
    /** Pixels the step moves aside while another is dragged past it. */
    readonly shift: number;
    readonly dragged: boolean;
    readonly onDragStart: (event: PointerEvent<HTMLElement>) => void;
    readonly evaluation: NodeEvaluation;
    readonly onSelect: (event: MouseEvent) => void;
    /** A click on the cross-hatched bar. */
    readonly onShared: (event: MouseEvent) => void;
    readonly onOpen: () => void;
    readonly onMenu: (event: MouseEvent) => void;
}

function TimelineStep(props: TimelineStepProps) {
    const { entry, label, future, selected, picked, lanes, colors } = props;
    const icon =
        entry.kind === "feature" && entry.feature.icon !== undefined
            ? entry.feature.icon
            : isNodeIcon(entry.node)
              ? entry.node.icon
              : "icon-box";
    const parts = lanes.owner === undefined ? [] : [lanes.owner, ...lanes.users];
    const hatched = parts.length > MAX_LANES;
    const joins = join(props.joinLeft && "left", props.joinRight && "right");
    return (
        <button
            type="button"
            className={join(
                style.step,
                future && style.future,
                selected && style.selected,
                picked && style.picked,
                props.dragged && style.dragged,
                entry.kind === "feature" && entry.feature.suppressed && style.suppressed,
            )}
            style={props.shift !== 0 ? { transform: `translateX(${props.shift}px)` } : undefined}
            data-key={entry.key}
            data-span="1"
            data-slot=""
            onPointerDown={props.onDragStart}
            data-future={future}
            data-picked={picked || undefined}
            data-grouped={props.grouped}
            aria-label={label}
            aria-pressed={selected || picked}
            title={props.title}
            onClick={(event) => {
                event.stopPropagation();
                if (hatched && (event.target as Element).closest("[data-shared]") !== null) {
                    props.onShared(event);
                    return;
                }
                props.onSelect(event);
            }}
            onDoubleClick={(event) => {
                event.stopPropagation();
                props.onOpen();
            }}
            onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onMenu(event);
            }}
        >
            <span
                className={style.lanes}
                data-lanes={parts.map((part) => part.name).join(",")}
                data-join={joins || undefined}
                data-shared={hatched ? parts.length : undefined}
                aria-hidden="true"
            >
                {hatched
                    ? null
                    : parts.map((part, i) => (
                          <span
                              key={part.id}
                              className={i === 0 ? style.ownerLane : style.userLane}
                              style={{ background: colors.get(part) }}
                          />
                      ))}
            </span>
            <TypeIcon icon={icon} />
            <StepStatus entry={entry} evaluation={props.evaluation} />
        </button>
    );
}

interface GroupChipProps {
    readonly group: TimelineGroup;
    readonly open: boolean;
    readonly count: number;
    readonly future: boolean;
    readonly renaming: boolean;
    readonly shift: number;
    readonly dragged: boolean;
    readonly onToggle: () => void;
    readonly onRename: () => void;
    /** The new name, or undefined when renaming was cancelled. */
    readonly onRenamed: (name: string | undefined) => void;
    readonly onMenu: (event: MouseEvent) => void;
    readonly onDragStart: (event: PointerEvent<HTMLElement>) => void;
    readonly suppressClick: RefObject<boolean>;
}

/** A group on the track: collapsed, it stands for all its steps; open, it heads them. */
function GroupChip(props: GroupChipProps) {
    const { group, open, count } = props;
    const title = t("timeline.groupSteps{0}{1}", group.name, count);
    if (props.renaming) {
        return (
            <input
                key="rename"
                className={style.rename}
                defaultValue={group.name}
                aria-label={t("timeline.renameGroup")}
                data-group={group.id}
                // biome-ignore lint/a11y/noAutofocus: the user asked to rename this chip
                autoFocus
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") props.onRenamed(event.currentTarget.value);
                    else if (event.key === "Escape") props.onRenamed(undefined);
                }}
                onBlur={(event) => props.onRenamed(event.currentTarget.value)}
            />
        );
    }
    const toggle = (event: { stopPropagation: () => void }) => {
        event.stopPropagation();
        props.onToggle();
    };
    return (
        <span
            className={join(style.groupSlot, props.dragged && style.dragged)}
            style={props.shift !== 0 ? { transform: `translateX(${props.shift}px)` } : undefined}
            data-group={group.id}
            data-span={open ? 0 : count}
            data-slot=""
        >
            <button
                type="button"
                className={join(style.group, open && style.groupOpen, props.future && style.future)}
                aria-expanded={open}
                aria-label={title}
                title={`${title}\n${t("timeline.dragToReorder")}`}
                onPointerDown={props.onDragStart}
                onClick={(event) => {
                    event.stopPropagation();
                    if (props.suppressClick.current) {
                        props.suppressClick.current = false;
                        return;
                    }
                    props.onToggle();
                }}
                onDoubleClick={(event) => {
                    event.stopPropagation();
                    props.onRename();
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    props.onMenu(event);
                }}
            >
                <TypeIcon icon="icon-folder" />
                <span className={style.groupName}>{group.name}</span>
                {open ? null : <span className={style.count}>{count}</span>}
            </button>
            <button
                type="button"
                className={style.groupToggle}
                aria-label={open ? t("timeline.collapse") : t("timeline.expand")}
                title={open ? t("timeline.collapse") : t("timeline.expand")}
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={toggle}
            >
                {open ? "−" : "+"}
            </button>
        </span>
    );
}

/** The parts relying on a step whose bars overflowed into the cross-hatched bar. */
function SharedParts(props: {
    lanes: TimelineLanes;
    colors: ReadonlyMap<INode, string>;
    x: number;
    y: number;
    onPick: (part: INode) => void;
    onClose: () => void;
}) {
    const root = useRef<HTMLDivElement>(null);
    useDismiss(root, props.onClose);
    const parts =
        props.lanes.owner === undefined ? props.lanes.users : [props.lanes.owner, ...props.lanes.users];
    return (
        <div
            ref={root}
            className={style.popover}
            role="dialog"
            aria-label={t("timeline.sharedTitle")}
            style={{ left: props.x, top: props.y }}
        >
            <h4>{t("timeline.sharedTitle")}</h4>
            {parts.map((part) => (
                <button key={part.id} type="button" onClick={() => props.onPick(part)}>
                    <span
                        className={style.swatch}
                        style={{ background: props.colors.get(part) }}
                        aria-hidden="true"
                    />
                    {part.name}
                </button>
            ))}
        </div>
    );
}

function GroupMenu(props: {
    group: TimelineGroup;
    x: number;
    y: number;
    onClose: () => void;
    onRename: () => void;
    onToggle: () => void;
    onUngroup: () => void;
}) {
    const root = useRef<HTMLDivElement>(null);
    useDismiss(root, props.onClose);
    return (
        <div
            ref={root}
            className={style.popover}
            role="menu"
            aria-label={props.group.name}
            style={{ left: props.x, top: props.y }}
        >
            <button type="button" role="menuitem" onClick={props.onToggle}>
                {props.group.collapsed ? t("timeline.expand") : t("timeline.collapse")}
            </button>
            <button type="button" role="menuitem" onClick={props.onRename}>
                {t("timeline.renameGroup")}
            </button>
            <button type="button" role="menuitem" onClick={props.onUngroup}>
                {t("timeline.ungroup")}
            </button>
        </div>
    );
}

/** Closes a popover on a pointer down outside it or Escape. */
function useDismiss(root: RefObject<HTMLElement | null>, close: () => void) {
    useEffect(() => {
        const onPointerDown = (event: Event) => {
            if (!root.current?.contains(event.target as Node)) close();
        };
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key === "Escape") close();
        };
        globalThis.document.addEventListener("pointerdown", onPointerDown, true);
        globalThis.document.addEventListener("keydown", onKeyDown);
        return () => {
            globalThis.document.removeEventListener("pointerdown", onPointerDown, true);
            globalThis.document.removeEventListener("keydown", onKeyDown);
        };
    }, [root, close]);
}

/**
 * The shared evaluation indicator (`@chili3d/react`), failures only — the integration point
 * with the feature tree's Ready / Computing / Changed / Failed states.
 */
function StepStatus({ entry, evaluation }: { entry: PartStudioTimelineEntry; evaluation: NodeEvaluation }) {
    const featureId = entry.kind === "feature" ? entry.feature.id : undefined;
    const source = useMemo(
        () => (featureId === undefined ? evaluation.node : evaluation.feature(featureId)),
        [evaluation, featureId],
    );
    return (
        <span className={style.status}>
            <LiveEvaluationIndicator source={source} onlyFailed />
        </span>
    );
}

/** The model tree's type icon (one icon lookup for tree and timeline). */
function TypeIcon({ icon }: { icon: string }) {
    const host = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
        host.current?.replaceChildren(createTypeIcon(icon, style.icon));
    }, [icon]);
    return <span ref={host} className={style.iconHost} aria-hidden="true" />;
}

function ControlButton(props: {
    label: string;
    disabled?: boolean;
    pressed?: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            className={style.control}
            aria-label={props.label}
            aria-pressed={props.pressed}
            title={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
        >
            <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">
                {props.children}
            </svg>
        </button>
    );
}

function TimelineSettings() {
    const [open, setOpen] = useState(false);
    const shown = useShowTimeline();
    const root = useRef<HTMLDivElement>(null);
    const cog = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    // The menu is portalled to the body and fixed above the cog's right edge: the timeline
    // host is its own low stacking context, so a menu drawn inside it would sit under the
    // viewport's own controls (the utilities in its corner, the view cube, the sidebar handle)
    // whatever its z-index.
    const anchor = (): CSSProperties => {
        const rect = cog.current?.getBoundingClientRect();
        if (rect === undefined) return {};
        return {
            right: `${Math.max(0, window.innerWidth - rect.right)}px`,
            bottom: `${Math.max(0, window.innerHeight - rect.top + 4)}px`,
        };
    };
    useEffect(() => {
        if (!open) return;
        const close = (event: Event) => {
            const target = event.target as Node;
            if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
        };
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false);
        };
        globalThis.document.addEventListener("pointerdown", close, true);
        globalThis.document.addEventListener("keydown", onKeyDown);
        return () => {
            globalThis.document.removeEventListener("pointerdown", close, true);
            globalThis.document.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);
    return (
        <div className={style.settings} ref={root}>
            <button
                type="button"
                ref={cog}
                className={style.control}
                aria-label={t("timeline.settings")}
                aria-haspopup="menu"
                aria-expanded={open}
                title={t("timeline.settings")}
                onClick={() => setOpen(!open)}
            >
                <svg width="14" height="14" aria-hidden="true" focusable="false">
                    <use href="#icon-cog" />
                </svg>
            </button>
            {open
                ? createPortal(
                      <div className={style.menu} role="menu" style={anchor()} ref={menu}>
                          <button
                              type="button"
                              role="menuitemcheckbox"
                              aria-checked={shown}
                              onClick={() => {
                                  setOpen(false);
                                  setShowTimeline(!shown);
                              }}
                          >
                              <span className={style.check} aria-hidden="true">
                                  {shown ? "✓" : ""}
                              </span>
                              {t("timeline.show")}
                          </button>
                      </div>,
                      globalThis.document.body,
                  )
                : null}
        </div>
    );
}

/** The active component of the document (`ComponentContext`), as it changes. */
function useActiveComponent(document: IDocument): INodeLinkedList | undefined {
    const [active, setActive] = useState(() => ComponentContext.activeOf(document));
    useEffect(() => {
        setActive(ComponentContext.activeOf(document));
        const handler = (changed: IDocument, component: INodeLinkedList | undefined) => {
            if (changed === document) setActive(component);
        };
        PubSub.default.sub("activeComponentChanged", handler);
        return () => PubSub.default.remove("activeComponentChanged", handler);
    }, [document]);
    return active;
}

/** The selected nodes, following the document's selection. */
function useSelectedNodes(document: IDocument): readonly INode[] {
    const [selected, setSelected] = useState<readonly INode[]>(() => document.selection.getSelectedNodes());
    useEffect(() => {
        const handler = (nodes: INode[]) => setSelected([...nodes]);
        setSelected(document.selection.getSelectedNodes());
        document.selection.onNodeChanged.sub(handler);
        return () => document.selection.onNodeChanged.remove(handler);
    }, [document]);
    return selected;
}

/** Play steps from the marker to the end (from the start when already there); stop pauses. */
function usePlayback(timeline: PartStudioTimeline, interval: number) {
    const [playing, setPlaying] = useState(false);
    useEffect(() => {
        if (!playing) return;
        const timer = setInterval(() => {
            if (!timeline.isRolledBack || !timeline.step(1) || !timeline.isRolledBack) setPlaying(false);
        }, interval);
        return () => clearInterval(timer);
    }, [playing, timeline, interval]);
    const toggle = (play: boolean) => {
        if (play && !timeline.isRolledBack) timeline.start();
        setPlaying(play && timeline.length > 0);
    };
    return [playing, toggle] as const;
}

/** Scrolls the track so the marker stays visible. */
function useKeepInView(
    scroller: RefObject<HTMLDivElement | null>,
    marker: RefObject<HTMLDivElement | null>,
    position: number,
    entries: readonly PartStudioTimelineEntry[],
) {
    useLayoutEffect(() => {
        const track = scroller.current;
        const element = marker.current;
        if (!track || !element) return;
        const margin = 24;
        const left = element.offsetLeft;
        if (left - margin < track.scrollLeft) track.scrollLeft = Math.max(0, left - margin);
        else if (left + margin > track.scrollLeft + track.clientWidth)
            track.scrollLeft = left + margin - track.clientWidth;
    }, [scroller, marker, position, entries]);
}

/**
 * Dragging the marker previews the position under the pointer (snapping between steps) and
 * applies it on release; a cancelled drag keeps the old position. Every element on the track
 * says how many steps it stands for (`data-span`: a step one, a collapsed group all of its).
 */
function useMarkerDrag(
    timeline: PartStudioTimeline,
    scroller: RefObject<HTMLDivElement | null>,
    setPreview: (position: number | undefined) => void,
) {
    const stop = useRef<(() => void) | undefined>(undefined);
    useEffect(() => () => stop.current?.(), []);
    return (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        stop.current?.();
        event.currentTarget.focus();
        let target = timeline.position;
        const move = (e: globalThis.PointerEvent) => {
            target = 0;
            for (const element of scroller.current?.querySelectorAll<HTMLElement>("[data-span]") ?? []) {
                const rect = element.getBoundingClientRect();
                if (e.clientX > rect.left + rect.width / 2) target += Number(element.dataset["span"]) || 0;
            }
            setPreview(target);
        };
        const cleanup = () => {
            stop.current = undefined;
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", cancel);
        };
        const up = () => {
            cleanup();
            setPreview(undefined);
            timeline.rollTo(target);
        };
        const cancel = () => {
            cleanup();
            setPreview(undefined);
        };
        stop.current = cleanup;
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", cancel);
    };
}
