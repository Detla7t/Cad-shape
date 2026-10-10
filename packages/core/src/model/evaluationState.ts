// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys } from "../i18n";

/**
 * Where an evaluated item stands — a Part Studio feature or body, a CAM operation. One
 * vocabulary, so every list shows evaluation the same way (`EvaluationIndicator` in
 * `@chili3d/react`), whatever the producer's own flags are:
 *
 * - `ready` — the shown result is up to date.
 * - `computing` — a new result is being made.
 * - `changed` — the shown result (if any) no longer matches its inputs, or none was made
 *   yet; `reason` says what moved.
 * - `failed` — the latest evaluation failed with `message`; `lastGoodShown` says whether the
 *   model still shows the last successful result. `at` names the failing item within its
 *   owner (a feature id of a body), so the UI can open it.
 *
 * Items that are not evaluated by design (suppressed, rolled back) have no state (`undefined`).
 */
export type EvaluationState =
    | { readonly kind: "ready" }
    | { readonly kind: "computing" }
    | { readonly kind: "changed"; readonly reason: string }
    | {
          readonly kind: "failed";
          readonly message: string;
          readonly lastGoodShown: boolean;
          readonly at?: string;
      };

export type EvaluationKind = EvaluationState["kind"];

export const EVALUATION_READY: EvaluationState = Object.freeze({ kind: "ready" });
export const EVALUATION_COMPUTING: EvaluationState = Object.freeze({ kind: "computing" });

/**
 * A live evaluation state: what the shared indicator subscribes to. `state()` is read on
 * every notification; it may build a new object each time (consumers compare with
 * `sameEvaluationState`).
 */
export interface IEvaluationStateSource {
    state(): EvaluationState | undefined;
    /** Calls `listener` when the state may have changed; returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
}

const LABELS: Record<EvaluationKind, I18nKeys> = {
    ready: "evaluation.ready",
    computing: "evaluation.computing",
    changed: "evaluation.changed",
    failed: "evaluation.failed",
};

/** The short text label of a state (never colour alone). */
export function evaluationLabel(state: EvaluationState): string {
    return I18n.translate(LABELS[state.kind]);
}

/** The tooltip: the reason or message, and whether the last successful result is shown. */
export function evaluationTooltip(state: EvaluationState): string {
    switch (state.kind) {
        case "ready":
        case "computing":
            return evaluationLabel(state);
        case "changed":
            return state.reason;
        case "failed":
            return state.lastGoodShown
                ? `${state.message}\n${I18n.translate("evaluation.lastGoodShown")}`
                : state.message;
    }
}

export function sameEvaluationState(a: EvaluationState | undefined, b: EvaluationState | undefined): boolean {
    if (a === b) return true;
    if (a === undefined || b === undefined || a.kind !== b.kind) return false;
    if (a.kind === "changed") return a.reason === (b as typeof a).reason;
    if (a.kind === "failed") {
        const other = b as typeof a;
        return a.message === other.message && a.lastGoodShown === other.lastGoodShown && a.at === other.at;
    }
    return true;
}
