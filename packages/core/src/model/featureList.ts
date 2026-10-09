// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Result } from "../foundation/result";
import type { I18nKeys } from "../i18n";
import type { UnitSpec } from "../parameters/unitSpec";
import type { INode } from "./node";

/** A temporary feature draft. Only Apply records a document change. */
export interface IFeatureEditSession {
    readonly featureId: string;
    readonly closed: boolean;
    /** True while the feature exists only in the draft: applying inserts it, cancelling drops it. */
    readonly inserting?: boolean;
    /** The pick parameter currently taking selections (Onshape's active query box). */
    readonly activePick?: string;
    onClose?: () => void;
    /** Fires when `activePick` changes. */
    onPickChanged?: () => void;
    apply(): Promise<Result<void>>;
    cancel(): Promise<void>;
}

/**
 * How a feature dialog opens. `insert` stages a brand-new feature (the node's own feature
 * payload) in the draft only — Onshape's flow, where a new feature exists once ✓ commits
 * it and ✗ leaves no trace. `pick` names the pick parameter that takes selections first.
 */
export interface FeatureEditOptions {
    readonly insert?: unknown;
    readonly pick?: string;
}

/**
 * What a pick parameter accepts: sub-shapes of the body, whole parts (solids) of it, or
 * the document's reference planes.
 */
export type FeaturePickKind = "edge" | "face" | "vertex" | "body" | "plane";

/** A single editable parameter of a feature, rendered by the feature list panel. */
export interface FeatureParameter {
    readonly key: string;
    readonly display: I18nKeys;
    /**
     * A literal label shown instead of translating `display` — for parameters a user
     * script defines (FeatureScript custom features name their own parameters).
     */
    readonly label?: string;
    /**
     * Literal number or an expression string (e.g. `width * 2`) resolved at rebuild;
     * booleans render as a checkbox (e.g. a boolean feature's consume-tools toggle).
     */
    readonly value: number | string | boolean;
    /** The unit the slot expects — the panel hints it, the rebuild enforces it. */
    readonly unit?: UnitSpec;
    /** A closed set of choices (`value` is one of them) — rendered as a dropdown. */
    readonly options?: readonly FeatureParameterOption[];
    /** Set for free text: the panel passes what was typed through unchanged, never as a number. */
    readonly text?: boolean;
    /**
     * Set for a pick of the body's own entities: the panel shows `value` (a summary such
     * as "2 edges") with a button that starts `reselectShapes(featureId, key)`.
     */
    readonly pick?: { readonly kinds: readonly FeaturePickKind[] };
    /**
     * How a closed set of choices renders: `tabs` for a row of toggle buttons (Onshape's
     * horizontal enum — New / Add / Remove / Intersect), else a dropdown.
     */
    readonly optionStyle?: "tabs";
    /** Set on a checkbox that flips a direction: rendered as Onshape's flip-arrow toggle. */
    readonly flip?: boolean;
    /**
     * Whether the panel offers to configure the slot (`configure(…)` per configuration). A
     * numeric slot is configurable unless this is `false` — it resolves through
     * `resolveUnitSpec`, which selects the arm; a checkbox, dropdown or free-text slot only
     * when its feature sets this, as only such a feature knows to select the arm.
     */
    readonly configurable?: boolean;
    /**
     * The stored `configure(…)` value when the slot is configured; `value` is then what the
     * active configuration selects (a checkbox's boolean, a dropdown's option), for display.
     * A numeric slot may leave this unset and hand the configured value in `value` itself.
     */
    readonly configured?: string;
}

export interface FeatureParameterOption {
    readonly value: string;
    readonly label: string;
}

/**
 * A node a feature holds and the panel shows as a link row (e.g. the sketch an
 * extrude consumes). The node keeps its own row in the tree; this is a second
 * entry point, so the panel shows *which* feature holds it.
 */
export interface FeatureReference {
    /** Identifies the reference slot on the feature (e.g. `sketchId`). */
    readonly key: string;
    readonly display: I18nKeys;
    readonly node: INode;
}

/** One row of a parametric body's ordered feature list. */
export interface FeatureItem {
    readonly id: string;
    readonly display: I18nKeys;
    /** User-assigned name; the panel shows it instead of `display` when set. */
    readonly name?: string;
    /** Iconfont key shown before the display name (e.g. "icon-fillet"). */
    readonly icon?: string;
    /** Suppressed features are skipped on rebuild and shown dimmed — in the active configuration. */
    readonly suppressed?: boolean;
    /** The `configure(…)` value of a feature whose suppression is configured. */
    readonly suppressionConfigured?: string;
    /** Set when this feature failed to rebuild — the panel highlights the row and keeps it expanded. */
    readonly error?: string;
    /**
     * Set for a softer, non-fatal condition (e.g. a sketch's dangling external
     * reference): the panel tints the row and shows the text when expanded, but
     * does not force expansion like an error does.
     */
    readonly warning?: string;
    /** Set when the feature's shape references (e.g. fillet edges) can be re-picked. */
    readonly reselectable?: boolean;
    /** Nodes this feature holds (e.g. its sketch), shown as link rows above the parameters. */
    readonly references?: readonly FeatureReference[];
    readonly parameters: readonly FeatureParameter[];
}

/**
 * Implemented by nodes that own an ordered, editable feature list (e.g. parametric
 * bodies). The property panel renders this contract without knowing the concrete
 * node or feature types.
 */
export interface IFeatureListNode {
    beginFeatureEdit?(featureId: string, options?: FeatureEditOptions): Promise<Result<IFeatureEditSession>>;
    readonly rollbackIndex?: number;
    setRollbackIndex?(index: number | undefined): boolean;
    featureItems(): readonly FeatureItem[];
    setFeatureParameter(featureId: string, key: string, value: number | string | boolean): void;
    /** `true`/`false`, or a `configure(…)` value over a list or checkbox input (configured suppression). */
    setFeatureSuppressed(featureId: string, suppressed: boolean | string): void;
    moveFeature(featureId: string, offset: -1 | 1): void;
    /** Moves a feature to an absolute index in one step; panels fall back to `moveFeature`. */
    moveFeatureTo?(featureId: string, index: number): void;
    /** Assigns a custom display name; an empty name clears it. */
    renameFeature?(featureId: string, name: string): void;
    removeFeature(featureId: string): void;
    /**
     * Re-picks the shapes a feature references (e.g. the edges of a fillet). `key` names
     * the parameter for features with several picks (a `FeatureParameter.pick` row).
     */
    reselectShapes?(featureId: string, key?: string): void;
    /**
     * Opens the node one of the feature's references points at (e.g. entering the
     * sketch an extrude consumes). `key` is the reference's own key, as reported in
     * `FeatureItem.references`.
     */
    activateReference?(featureId: string, key: string): void;
}

export function isFeatureListNode(node: unknown): node is IFeatureListNode {
    const candidate = node as IFeatureListNode;
    return (
        typeof candidate?.featureItems === "function" &&
        typeof candidate?.setFeatureParameter === "function" &&
        typeof candidate?.removeFeature === "function"
    );
}
