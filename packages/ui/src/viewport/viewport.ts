// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type Act,
    Binding,
    type CameraType,
    I18n,
    type IConverter,
    type IEventHandler,
    type IView,
    Localize,
    PubSub,
    Result,
    type ShapeType,
    ShapeTypes,
    type ViewMode,
    ViewModeI18nKeys,
    ViewModes,
} from "@chili3d/core";
import { collection, div, input, label, span, svg } from "@chili3d/element";
import { showNodeContextMenu } from "../project/nodeContextMenu";
import { ViewportUtilities } from "../review/viewportUtilities";
import { Flyout } from "./flyout";
import style from "./viewport.module.css";

class CameraConverter implements IConverter<CameraType> {
    constructor(readonly type: CameraType) {}

    convert(value: CameraType): Result<string, string> {
        if (value === this.type) {
            return Result.ok(style.actived);
        }
        return Result.ok("");
    }
}

class ViewModeConverter implements IConverter<ViewMode> {
    constructor(readonly mode: ViewMode) {}

    convert(value: ViewMode): Result<string, string> {
        if (value === this.mode) {
            return Result.ok(style.actived);
        }
        return Result.ok("");
    }
}

export class Viewport extends HTMLElement {
    private readonly _flyout: Flyout;
    private readonly _eventCaches: [keyof HTMLElementEventMap, (e: any) => void][] = [];
    private readonly _acts: HTMLElement;
    private readonly utilities: ViewportUtilities;

    constructor(
        readonly view: IView,
        readonly showViewControls: boolean,
    ) {
        super();
        this.className = style.root;
        this._flyout = new Flyout();
        this._acts = this.createActs();
        this.utilities = new ViewportUtilities(view);
        this.render();
        view.setDom(this);
    }

    private readonly onActCollectionChanged = () => {
        if (this.view.document.acts.length === 0) {
            this._acts.style.display = "none";
        } else {
            this._acts.style.display = "flex";
        }
    };

    private render() {
        this.append(
            this.utilities.element,
            this._acts,
            this.showViewControls
                ? div(
                      {
                          className: style.viewControls,
                          onpointerdown: (ev) => ev.stopPropagation(),
                          onclick: (e) => e.stopPropagation(),
                      },
                      this.createCameraControls(),
                      this.createActionControls(),
                  )
                : "",
            this.createViewModeControl(),
        );
    }

    private createCameraControls() {
        return div(
            { className: style.border },
            this.createCameraControl("orthographic", "icon-orthographic"),
            this.createCameraControl("perspective", "icon-perspective"),
        );
    }

    private createActionControls() {
        return div(
            { className: style.border },
            svg({
                icon: "icon-fitcontent",
                title: new Localize("viewport.fitContent"),
                onclick: async (e) => {
                    e.stopPropagation();
                    this.view.cameraController.fitContent();
                    this.view.update();
                },
            }),
            svg({
                icon: "icon-zoomin",
                title: new Localize("viewport.zoomIn"),
                onclick: () => {
                    this.view.cameraController.zoom(this.view.width / 2, this.view.height / 2, -5);
                    this.view.update();
                },
            }),
            svg({
                icon: "icon-zoomout",
                title: new Localize("viewport.zoomOut"),
                onclick: () => {
                    this.view.cameraController.zoom(this.view.width / 2, this.view.height / 2, 5);
                    this.view.update();
                },
            }),
        );
    }

    private createActs() {
        return div(
            { className: style.actsContainer },
            div(
                {
                    className: style.border,
                    onpointerdown: (ev) => ev.stopPropagation(),
                    onclick: (e) => e.stopPropagation(),
                },
                collection({
                    className: style.acts,
                    sources: this.view.document.acts,
                    template: (v) => {
                        return div(
                            {
                                onclick: () => {
                                    this.view.cameraController.lookAt(
                                        v.cameraPosition,
                                        v.cameraTarget,
                                        v.cameraUp,
                                    );
                                    this.view.update();
                                },
                            },
                            span({
                                textContent: new Binding(v, "name"),
                            }),
                            div(
                                {
                                    className: style.tools,
                                },
                                svg({
                                    icon: "icon-cog",
                                    onclick: () => this.setActName(v),
                                }),
                                svg({
                                    icon: "icon-times",
                                    onclick: () => {
                                        this.view.document.acts.remove(v);
                                    },
                                }),
                            ),
                        );
                    },
                    onwheel: (e) => {
                        e.preventDefault();
                        const container = e.currentTarget as HTMLElement;
                        container.scrollLeft += e.deltaY;
                    },
                }),
            ),
        );
    }

    private readonly setActName = (act: Act) => {
        const inputBox = input({
            value: act.name,
            onkeydown: (e) => {
                e.stopPropagation();
            },
        });
        PubSub.default.pub(
            "showDialog",
            "ribbon.group.act",
            div(label({ textContent: new Localize("common.name") }), ": ", inputBox),
            () => {
                act.name = inputBox.value;
            },
        );
    };

    private createCameraControl(cameraType: CameraType, icon: string) {
        return div(
            {
                className: new Binding(
                    this.view.cameraController,
                    "cameraType",
                    new CameraConverter(cameraType),
                ),
            },
            svg({
                icon: icon,
                title: new Localize(`viewport.${cameraType}`),
                onclick: (e) => {
                    e.stopPropagation();
                    this.view.cameraController.cameraType = cameraType;
                    this.view.update();
                },
            }),
        );
    }

    private createViewModeControl() {
        const label = span({
            textContent: new Localize(ViewModeI18nKeys[this.view.mode]),
        });
        return div(
            {
                className: style.viewModeControl,
            },
            div(
                {
                    className: style.viewModeDisplay,
                    onclick: (e) => {
                        e.stopPropagation();
                        const target = e.currentTarget as HTMLElement;
                        if (target.nextElementSibling instanceof HTMLElement) {
                            target.nextElementSibling.classList.toggle(style.visible);
                        }
                    },
                },
                "[ ",
                label,
                " ]",
            ),
            div(
                {
                    className: style.viewModeMenu,
                },
                ...ViewModes.map((m) =>
                    div({
                        className: new Binding(this.view, "mode", new ViewModeConverter(m)),
                        textContent: new Localize(ViewModeI18nKeys[m]),
                        onclick: (e) => {
                            e.stopPropagation();
                            I18n.set(label, "textContent", ViewModeI18nKeys[m]);
                            this.view.mode = m;
                            this.view.update();

                            const target = e.currentTarget as HTMLElement;
                            if (target.parentElement instanceof HTMLElement) {
                                target.parentElement.classList.remove(style.visible);
                            }
                        },
                    }),
                ),
            ),
        );
    }

    connectedCallback() {
        this.addEventListener("pointerdown", this.activate, true);
        this.addEventListener("wheel", this.activate, true);
        this.initEvent();
        this.appendChild(this._flyout);
        this.view.document.acts.onCollectionChanged(this.onActCollectionChanged);
        this.onActCollectionChanged();
    }

    disconnectedCallback() {
        this.utilities.dispose();
        this.removeEventListener("pointerdown", this.activate, true);
        this.removeEventListener("wheel", this.activate, true);
        this.removeEvents();
        this._flyout.remove();
        this.view.document.acts.removeCollectionChanged(this.onActCollectionChanged);
    }

    dispose() {
        this.removeEvents();
    }

    private readonly activate = () => {
        if (this.view.document.application.activeView !== this.view)
            this.view.document.application.activeView = this.view;
    };

    private rightGesture?: { down: PointerEvent; moved: boolean };
    private selectionPointer?: number;

    private initEvent() {
        const events: [keyof HTMLElementEventMap, (e: any) => any][] = [
            ["pointerdown", this.pointerDown],
            ["pointermove", this.pointerMove],
            ["pointerout", this.pointerOut],
            ["pointerup", this.pointerUp],
            ["pointercancel", this.pointerCancel],
            ["lostpointercapture", this.pointerCancel],
            ["wheel", this.mouseWheel],
            ["dblclick", this.doubleClick],
        ];
        events.forEach((v) => {
            this.addEventListenerHandler(v[0], v[1]);
        });
    }

    private addEventListenerHandler(type: keyof HTMLElementEventMap, handler: (e: any) => any) {
        const listener = (e: any) => {
            e.preventDefault();
            handler(e);
        };
        this.addEventListener(type, listener);
        this._eventCaches.push([type, listener]);
    }

    private removeEvents() {
        if (this.rightGesture) this.pointerCancel(this.rightGesture.down);
        this.selectionPointer = undefined;
        this._eventCaches.forEach((x) => {
            this.removeEventListener(x[0], x[1]);
        });
        this._eventCaches.length = 0;
    }

    private readonly handleEvent = (
        eventName: Exclude<keyof IEventHandler, "isEnabled" | "dispose" | "resolveCommand">,
        event: PointerEvent | WheelEvent,
    ) => {
        if (this.view.document.visual.eventHandler.isEnabled)
            this.view.document.visual.eventHandler[eventName]?.(this.view, event as any);
        if (this.view.document.visual.viewHandler.isEnabled)
            this.view.document.visual.viewHandler[eventName]?.(this.view, event as any);
    };

    private readonly pointerMove = (event: PointerEvent) => {
        if (this.rightGesture) {
            const { down } = this.rightGesture;
            if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) >= 3)
                this.rightGesture.moved = true;
            if (this.rightGesture.moved && this.view.document.visual.viewHandler.isEnabled)
                this.view.document.visual.viewHandler.pointerMove(this.view, event);
            return;
        }
        if (this._flyout) {
            this._flyout.style.top = `${event.offsetY}px`;
            this._flyout.style.left = `${event.offsetX}px`;
        }

        this.handleEvent("pointerMove", event);
    };

    private readonly pointerDown = (event: PointerEvent) => {
        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }

        if (this.view.document.application.activeView !== this.view) {
            this.view.document.application.activeView = this.view;
        }

        if (event.button === 2 && event.pointerType === "mouse") {
            // Delay a right-click's tool action until release, distinguishing it from orbit.
            this.rightGesture = { down: event, moved: false };
            try {
                this.setPointerCapture?.(event.pointerId);
            } catch {
                /* Synthetic pointers have no capture. */
            }
            if (this.view.document.visual.viewHandler.isEnabled)
                this.view.document.visual.viewHandler.pointerDown(this.view, event);
            return;
        }
        if (event.button === 0 && event.isPrimary) {
            this.selectionPointer = event.pointerId;
            try {
                this.setPointerCapture?.(event.pointerId);
            } catch {
                /* Synthetic pointers have no capture. */
            }
        }
        this.handleEvent("pointerDown", event);
    };

    private readonly pointerUp = (event: PointerEvent) => {
        const gesture = this.rightGesture;
        if (gesture) {
            this.rightGesture = undefined;
            const visual = this.view.document.visual;
            if (visual.viewHandler.isEnabled) visual.viewHandler.pointerUp(this.view, event);
            if (!gesture.moved && visual.eventHandler.isEnabled) {
                if (
                    visual.eventHandler.contextMenu?.(this.view, gesture.down) ||
                    (visual.eventHandler === visual.defaultEventHandler && this.openContextMenu(gesture.down))
                ) {
                    event.preventDefault();
                } else {
                    visual.eventHandler.pointerDown(this.view, gesture.down);
                    visual.eventHandler.pointerUp(this.view, event);
                }
            }
            if (this.hasPointerCapture?.(event.pointerId)) this.releasePointerCapture(event.pointerId);
            return;
        }
        this.handleEvent("pointerUp", event);
        if (this.selectionPointer === event.pointerId) {
            this.selectionPointer = undefined;
            if (this.hasPointerCapture?.(event.pointerId)) this.releasePointerCapture(event.pointerId);
        }
    };

    private openContextMenu(event: PointerEvent): boolean {
        const visual = this.view.detectVisual(event.offsetX, event.offsetY)[0];
        const node = visual && this.view.document.visual.context.getNode(visual);
        if (!node) return false;
        if (!this.view.document.selection.getSelectedNodes().includes(node))
            this.view.document.selection.setSelectedNodes([node], false);
        const picks = this.view.detectShapes(
            (ShapeTypes.face | ShapeTypes.edge | ShapeTypes.vertex) as ShapeType,
            event.offsetX,
            event.offsetY,
        );
        showNodeContextMenu(node, event.clientX, event.clientY, { view: this.view, picks });
        return true;
    }

    private readonly pointerCancel = (event: PointerEvent) => {
        if (this.selectionPointer === event.pointerId) {
            this.selectionPointer = undefined;
            this.handleEvent("pointerOut", event);
            if (this.hasPointerCapture?.(event.pointerId)) this.releasePointerCapture(event.pointerId);
        }
        if (!this.rightGesture) return;
        this.rightGesture = undefined;
        this.view.document.visual.viewHandler.pointerUp(this.view, event);
        if (this.hasPointerCapture?.(event.pointerId)) this.releasePointerCapture(event.pointerId);
    };

    private readonly pointerOut = (event: PointerEvent) => {
        if (this.rightGesture || this.selectionPointer !== undefined) return;
        this.handleEvent("pointerOut", event);
    };

    private readonly mouseWheel = (event: WheelEvent) => {
        this.handleEvent("mouseWheel", event);
    };

    /** Lets feature packages react to a viewport double-click (e.g. sketch editing). */
    private readonly doubleClick = (event: MouseEvent) => {
        const detected = this.view.detectVisual(event.offsetX, event.offsetY);
        const node = detected.length ? this.view.document.visual.context.getNode(detected[0]) : undefined;
        if (node === undefined) return;
        PubSub.default.pub("nodeDoubleClicked", node);
    };
}

customElements.define("chili-uiview", Viewport);
