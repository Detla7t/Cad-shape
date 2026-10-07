// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type Matrix, normalEquations, rank, rankAndNullSpace, solveLinear } from "../math/linalg";
import {
    add,
    applyMat,
    applyRigid,
    axisAngle,
    compose,
    cross,
    dot,
    expMap,
    type Frame,
    frameToRigid,
    IDENTITY3,
    invert,
    mulMat,
    norm,
    type Rigid,
    rigidToFrame,
    rotationBetween,
    scale,
    sub,
    transformFrame,
    UNIT_X,
    type Vec3,
} from "../math/rigid";

/**
 * The mate solver: finds rigid placements of an assembly's instances that satisfy its mates.
 *
 * **Model.** Every instance is a rigid body (6 DOF); grounded instances do not move. A mate
 * joins two MATE CONNECTORS — frames fixed on two instances — and constrains how the second
 * frame sits relative to the first: with Onshape's semantics the connectors are brought
 * together with their Z axes OPPOSED (face against face, the natural result of picking two
 * outward-normal faces), or aligned when the mate is `flipped`; an offset (translation in the
 * first connector's frame, rotation about its Z) shifts the target. Each type keeps some
 * relative motions free:
 *
 * | type        | free relative motion            | removes |
 * |-------------|---------------------------------|---------|
 * | fastened    | none                            | 6       |
 * | revolute    | rotation about Z                | 5       |
 * | slider      | translation along Z             | 5       |
 * | cylindrical | rotation about and along Z      | 4       |
 * | planar      | in-plane translation, about Z   | 3       |
 * | ball        | all rotations                   | 3       |
 * | parallel    | all translations, about Z       | 2       |
 *
 * **Solve.** Residuals are geometric (connector origins, Z and X axes; orientation terms scaled
 * by a characteristic length so millimetres and radians weigh alike). A breadth-first pass from
 * the grounded instances first SNAPS each newly reached instance onto its mate with the smallest
 * motion that satisfies it — so a mate created between far-apart parts converges from any
 * start, as Onshape moves the second part on mate creation. Levenberg–Marquardt then relaxes
 * every mate together (loops, several mates per pair); its damping makes each step the smallest
 * one, which leaves the free degrees of freedom where they were — the property dragging relies
 * on. Revolute and slider limits are enforced by an active set (a violated limit becomes an
 * equality at the nearer bound, and the solve repeats).
 *
 * **Diagnostics.** At the solution, the rank of the Jacobian of all mate residuals with respect
 * to the free instances' motions gives the remaining degrees of freedom (`6 × free − rank`);
 * the null space projected onto one instance gives that instance's own DOF. Mate DOF removed
 * beyond the rank is REDUNDANCY (over-constrained, though consistent); mates still violated
 * after the solve are CONFLICTING and listed as failing.
 */

export const MATE_TYPES = [
    "fastened",
    "revolute",
    "slider",
    "cylindrical",
    "planar",
    "ball",
    "parallel",
] as const;
export type MateType = (typeof MATE_TYPES)[number];

/** Degrees of freedom each mate type removes between its two instances. */
export const MATE_DOF_REMOVED: Readonly<Record<MateType, number>> = {
    fastened: 6,
    revolute: 5,
    slider: 5,
    cylindrical: 4,
    planar: 3,
    ball: 3,
    parallel: 2,
};

export interface SolverInstance {
    readonly id: string;
    readonly transform: Rigid;
    readonly grounded: boolean;
}

export interface SolverConnector {
    readonly instanceId: string;
    /** The connector in its instance's own coordinates. */
    readonly frame: Frame;
}

export interface MateOffset {
    readonly x?: number;
    readonly y?: number;
    readonly z?: number;
    /** Rotation about the first connector's Z, in radians. */
    readonly angle?: number;
}

export interface MateLimits {
    /** Revolute: radians; slider / cylindrical: mm along Z. */
    readonly min?: number;
    readonly max?: number;
}

export interface SolverMate {
    readonly id: string;
    readonly type: MateType;
    readonly a: SolverConnector;
    readonly b: SolverConnector;
    /** Align the Z axes instead of opposing them. */
    readonly flipped?: boolean;
    readonly offset?: MateOffset;
    readonly limits?: MateLimits;
}

export interface DragTarget {
    readonly instanceId: string;
    /** The grabbed point, in the instance's coordinates. */
    readonly localPoint: Vec3;
    /** Where the pointer wants it, in world coordinates. */
    readonly target: Vec3;
}

export interface SolveOptions {
    /** Largest acceptable mate violation, mm (orientation terms are scaled to mm). */
    readonly tolerance?: number;
    readonly maxIterations?: number;
    readonly drag?: DragTarget;
    /** Skip the snapping pass (a drag starts from an already solved state). */
    readonly noSnap?: boolean;
}

export interface MateReport {
    readonly id: string;
    /** Largest violation component, mm (orientation scaled). */
    readonly residual: number;
    readonly satisfied: boolean;
    /** The limit the solve had to clamp to, if any. */
    readonly limitActive?: "min" | "max";
    /** The mate's free coordinate after the solve: revolute angle (rad), slider/cylindrical distance (mm). */
    readonly value?: number;
}

export type SolveStatus = "solved" | "conflicting";

export interface SolveResult {
    readonly transforms: ReadonlyMap<string, Rigid>;
    readonly status: SolveStatus;
    readonly iterations: number;
    readonly mates: readonly MateReport[];
    readonly failingMates: readonly string[];
    /** Degrees of freedom left in the whole assembly. */
    readonly dof: number;
    /** Degrees of freedom of each non-grounded instance. */
    readonly instanceDof: ReadonlyMap<string, number>;
    /** Constraint equations beyond what the mates can independently remove. */
    readonly redundant: number;
    readonly overConstrained: boolean;
    readonly underConstrained: boolean;
    /** Instances that are neither grounded nor connected to a grounded one by mates. */
    readonly floating: readonly string[];
}

const DEFAULT_TOLERANCE = 1e-6;
const DRAG_WEIGHT = 0.05;

/** Rotation by π about X: turns a connector around so its Z axis opposes the original. */
const HALF_TURN_X = axisAngle(UNIT_X, Math.PI);

/** The rigid offset from connector A to where connector B must sit (offset, then the default flip). */
function mateOffsetRigid(mate: SolverMate): Rigid {
    const o = mate.offset;
    const shift: Rigid = {
        r: axisAngle([0, 0, 1], o?.angle ?? 0),
        t: [o?.x ?? 0, o?.y ?? 0, o?.z ?? 0],
    };
    return mate.flipped ? shift : compose(shift, { r: HALF_TURN_X, t: [0, 0, 0] });
}

/** Where connector B must be (world) for the mate, given connector A's world frame. */
export function mateTarget(mate: SolverMate, aWorld: Frame): Frame {
    return rigidToFrame(compose(frameToRigid(aWorld), mateOffsetRigid(mate)));
}

/** Where connector A must be (world) given connector B's — the inverse relation. */
function mateSource(mate: SolverMate, bWorld: Frame): Frame {
    return rigidToFrame(compose(frameToRigid(bWorld), invert(mateOffsetRigid(mate))));
}

/**
 * The free coordinate of a mate, measured against the first connector's Z (so a positive slider
 * distance moves B out of A's face): the revolute angle of B's X from the target X, or B's
 * distance from the target origin.
 */
function mateValue(type: MateType, a: Frame, target: Frame, b: Frame): number | undefined {
    if (type === "revolute") {
        return Math.atan2(dot(cross(target.x, b.x), a.z), dot(target.x, b.x));
    }
    if (type === "slider" || type === "cylindrical") return dot(sub(b.origin, target.origin), a.z);
    return undefined;
}

interface ActiveLimit {
    readonly side: "min" | "max";
    readonly value: number;
}

/** The mate's residual vector (mm). `length` scales orientation terms. */
function mateResiduals(
    mate: SolverMate,
    a: Frame,
    b: Frame,
    length: number,
    active: ActiveLimit | undefined,
    out: number[],
): void {
    const target = mateTarget(mate, a);
    const d = sub(b.origin, target.origin);
    const along = dot(d, target.z);
    const pushVec = (v: Vec3, s = 1) => out.push(v[0] * s, v[1] * s, v[2] * s);
    const lateral = () => pushVec(sub(d, scale(target.z, along)));
    const zAxis = () => pushVec(sub(b.z, target.z), length);
    const xAxis = () => pushVec(sub(b.x, target.x), length);
    switch (mate.type) {
        case "fastened":
            pushVec(d);
            zAxis();
            xAxis();
            break;
        case "revolute":
            pushVec(d);
            zAxis();
            break;
        case "slider":
            lateral();
            zAxis();
            xAxis();
            break;
        case "cylindrical":
            lateral();
            zAxis();
            break;
        case "planar":
            out.push(along);
            zAxis();
            break;
        case "ball":
            pushVec(d);
            break;
        case "parallel":
            zAxis();
            break;
    }
    if (active !== undefined) {
        const value = mateValue(mate.type, a, target, b) ?? 0;
        out.push((value - active.value) * (mate.type === "revolute" ? length : 1));
    }
}

interface Problem {
    readonly free: readonly string[];
    readonly index: ReadonlyMap<string, number>;
    readonly mates: readonly SolverMate[];
    readonly length: number;
}

class State {
    constructor(readonly transforms: Map<string, Rigid>) {}

    frameOf(connector: SolverConnector): Frame {
        const transform = this.transforms.get(connector.instanceId);
        return transform === undefined ? connector.frame : transformFrame(transform, connector.frame);
    }

    clone(): State {
        return new State(new Map(this.transforms));
    }
}

function residualVector(
    problem: Problem,
    state: State,
    active: ReadonlyMap<string, ActiveLimit>,
    drag: DragTarget | undefined,
): number[] {
    const out: number[] = [];
    for (const mate of problem.mates) {
        mateResiduals(
            mate,
            state.frameOf(mate.a),
            state.frameOf(mate.b),
            problem.length,
            active.get(mate.id),
            out,
        );
    }
    if (drag !== undefined) {
        const transform = state.transforms.get(drag.instanceId);
        if (transform !== undefined) {
            const point = applyRigid(transform, drag.localPoint);
            const delta = sub(point, drag.target);
            out.push(delta[0] * DRAG_WEIGHT, delta[1] * DRAG_WEIGHT, delta[2] * DRAG_WEIGHT);
        }
    }
    return out;
}

/** Moves instance `id` by a parameter vector: translation (mm), rotation (w/length rad) about its origin. */
function perturb(transform: Rigid, params: readonly number[], offset: number, length: number): Rigid {
    const rotation = expMap([
        params[offset + 3] / length,
        params[offset + 4] / length,
        params[offset + 5] / length,
    ]);
    return {
        r: mulMat(rotation, transform.r),
        t: add(transform.t, [params[offset], params[offset + 1], params[offset + 2]]),
    };
}

function applyStep(problem: Problem, state: State, step: readonly number[]): State {
    const next = state.clone();
    problem.free.forEach((id, i) => {
        next.transforms.set(id, perturb(state.transforms.get(id)!, step, i * 6, problem.length));
    });
    return next;
}

/** Central-difference Jacobian of the residuals with respect to every free instance's 6 motions. */
function jacobian(
    problem: Problem,
    state: State,
    active: ReadonlyMap<string, ActiveLimit>,
    drag: DragTarget | undefined,
    rows: number,
): Matrix {
    const cols = problem.free.length * 6;
    const out: Matrix = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
    const h = 1e-6 * Math.max(1, problem.length);
    const delta = new Array<number>(6).fill(0);
    problem.free.forEach((id, i) => {
        const base = state.transforms.get(id)!;
        for (let k = 0; k < 6; k++) {
            delta.fill(0);
            delta[k] = h;
            state.transforms.set(id, perturb(base, delta, 0, problem.length));
            const plus = residualVector(problem, state, active, drag);
            delta[k] = -h;
            state.transforms.set(id, perturb(base, delta, 0, problem.length));
            const minus = residualVector(problem, state, active, drag);
            for (let r = 0; r < rows; r++) out[r][i * 6 + k] = (plus[r] - minus[r]) / (2 * h);
        }
        state.transforms.set(id, base);
    });
    return out;
}

const maxAbs = (values: readonly number[]) => values.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const sumSquares = (values: readonly number[]) => values.reduce((s, v) => s + v * v, 0);

/** Levenberg–Marquardt on the current active set; returns the final state and iteration count. */
function levenbergMarquardt(
    problem: Problem,
    start: State,
    active: ReadonlyMap<string, ActiveLimit>,
    drag: DragTarget | undefined,
    tolerance: number,
    maxIterations: number,
): { state: State; iterations: number } {
    let state = start;
    let residual = residualVector(problem, state, active, drag);
    let cost = sumSquares(residual);
    let lambda = 1e-3;
    const cols = problem.free.length * 6;
    if (cols === 0) return { state, iterations: 0 };
    let iterations = 0;
    let done = false;
    while (!done && iterations < maxIterations) {
        if (drag === undefined && maxAbs(residual) < tolerance * 0.01) break;
        iterations++;
        const j = jacobian(problem, state, active, drag, residual.length);
        const { jtj, jtr } = normalEquations(j, residual, cols);
        done = true;
        while (lambda < 1e12) {
            const damped = jtj.map((row, i) => row.map((v, k) => (i === k ? v + lambda * (v + 1e-6) : v)));
            const step = solveLinear(
                damped,
                jtr.map((g) => -g),
            );
            if (step === undefined) {
                lambda *= 10;
                continue;
            }
            const candidate = applyStep(problem, state, step);
            const next = residualVector(problem, candidate, active, drag);
            const nextCost = sumSquares(next);
            if (nextCost < cost) {
                const gain = cost - nextCost;
                state = candidate;
                residual = next;
                cost = nextCost;
                lambda = Math.max(1e-9, lambda / 3);
                // Stalled: the cost no longer moves measurably.
                done = gain <= 1e-12 * Math.max(cost, 1e-20) || maxAbs(step) < 1e-13;
                break;
            }
            lambda *= 4;
        }
    }
    return { state, iterations };
}

// ------------------------------------------------------------------ Snapping

/** The smallest motion of the instance owning `moving` that brings that connector onto `target` for the mate type. */
function snapMotion(type: MateType, moving: Frame, target: Frame, needsX: boolean): Rigid {
    // Rotate about the moving connector's origin: first its Z onto the target Z ...
    let rotation = type === "ball" ? IDENTITY3 : rotationBetween(moving.z, target.z, moving.x);
    if (needsX) {
        // ... then about that Z until X lines up too.
        const x = applyMat(rotation, moving.x);
        rotation = mulMat(rotationBetween(x, target.x, target.z), rotation);
    }
    const pivot = moving.origin;
    const rotated: Rigid = { r: rotation, t: sub(pivot, applyMat(rotation, pivot)) };
    const d = sub(target.origin, moving.origin);
    const along = dot(d, target.z);
    let shift: Vec3 = [0, 0, 0];
    switch (type) {
        case "fastened":
        case "revolute":
        case "ball":
            shift = d;
            break;
        case "slider":
        case "cylindrical":
            shift = sub(d, scale(target.z, along));
            break;
        case "planar":
            shift = scale(target.z, along);
            break;
        case "parallel":
            break;
    }
    return compose({ r: IDENTITY3, t: shift }, rotated);
}

function snapPass(problem: Problem, state: State, grounded: ReadonlySet<string>, tolerance: number): void {
    const placed = new Set<string>(grounded);
    const pending = [...problem.mates];
    // Without any grounded instance the first mated one anchors the snapping (it is not grounded).
    if (placed.size === 0 && pending.length > 0) placed.add(pending[0].a.instanceId);
    let progress = true;
    while (progress) {
        progress = false;
        for (let i = 0; i < pending.length; i++) {
            const mate = pending[i];
            const aPlaced = placed.has(mate.a.instanceId);
            const bPlaced = placed.has(mate.b.instanceId);
            if (!aPlaced && !bPlaced) continue;
            pending.splice(i--, 1);
            progress = true;
            if (aPlaced && bPlaced) continue;
            const movingSide = aPlaced ? mate.b : mate.a;
            const id = movingSide.instanceId;
            placed.add(id);
            if (grounded.has(id) || !problem.index.has(id)) continue;
            const a = state.frameOf(mate.a);
            const b = state.frameOf(mate.b);
            const check: number[] = [];
            mateResiduals(mate, a, b, problem.length, undefined, check);
            if (maxAbs(check) < tolerance) continue;
            const target = aPlaced ? mateTarget(mate, a) : mateSource(mate, b);
            const needsX = mate.type === "fastened" || mate.type === "slider";
            const motion = snapMotion(mate.type, aPlaced ? b : a, target, needsX);
            state.transforms.set(id, compose(motion, state.transforms.get(id)!));
        }
    }
}

// ------------------------------------------------------------------ Diagnostics

function characteristicLength(mates: readonly SolverMate[]): number {
    let length = 1;
    for (const mate of mates) {
        length = Math.max(length, norm(mate.a.frame.origin), norm(mate.b.frame.origin));
    }
    return Math.min(length, 1e4);
}

function components(instances: readonly SolverInstance[], mates: readonly SolverMate[]): Map<string, string> {
    const parent = new Map(instances.map((x) => [x.id, x.id]));
    const find = (id: string): string => {
        let root = id;
        while (parent.get(root) !== root) root = parent.get(root)!;
        parent.set(id, root);
        return root;
    };
    for (const mate of mates) {
        if (!parent.has(mate.a.instanceId) || !parent.has(mate.b.instanceId)) continue;
        parent.set(find(mate.a.instanceId), find(mate.b.instanceId));
    }
    return new Map(instances.map((x) => [x.id, find(x.id)]));
}

/**
 * Solves the mates. Grounded instances keep their transforms; mates naming an unknown
 * instance are reported as failing and otherwise ignored.
 */
export function solveMates(
    instances: readonly SolverInstance[],
    mates: readonly SolverMate[],
    options: SolveOptions = {},
): SolveResult {
    const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
    const maxIterations = options.maxIterations ?? 200;
    const known = new Set(instances.map((x) => x.id));
    const valid = mates.filter(
        (m) => known.has(m.a.instanceId) && known.has(m.b.instanceId) && m.a.instanceId !== m.b.instanceId,
    );
    const invalid = mates.filter((m) => !valid.includes(m)).map((m) => m.id);
    const grounded = new Set(instances.filter((x) => x.grounded).map((x) => x.id));
    const mated = new Set(valid.flatMap((m) => [m.a.instanceId, m.b.instanceId]));
    const drag =
        options.drag !== undefined &&
        known.has(options.drag.instanceId) &&
        !grounded.has(options.drag.instanceId)
            ? options.drag
            : undefined;
    // Only instances that something acts on move; the rest keep their placement.
    const free = instances
        .filter((x) => !x.grounded && (mated.has(x.id) || drag?.instanceId === x.id))
        .map((x) => x.id);
    const problem: Problem = {
        free,
        index: new Map(free.map((id, i) => [id, i])),
        mates: valid,
        length: characteristicLength(valid),
    };
    let state = new State(new Map(instances.map((x) => [x.id, x.transform])));
    if (options.noSnap !== true) snapPass(problem, state, grounded, tolerance);

    // Active-set loop for limits.
    const active = new Map<string, ActiveLimit>();
    let iterations = 0;
    for (let pass = 0; pass < 4; pass++) {
        if (drag !== undefined) {
            const dragged = levenbergMarquardt(
                problem,
                state,
                active,
                drag,
                tolerance,
                Math.min(maxIterations, 40),
            );
            state = dragged.state;
            iterations += dragged.iterations;
        }
        const solved = levenbergMarquardt(problem, state, active, undefined, tolerance, maxIterations);
        state = solved.state;
        iterations += solved.iterations;
        let changed = false;
        for (const mate of valid) {
            const limits = mate.limits;
            if (limits === undefined || active.has(mate.id)) continue;
            const aFrame = state.frameOf(mate.a);
            const value = mateValue(mate.type, aFrame, mateTarget(mate, aFrame), state.frameOf(mate.b));
            if (value === undefined) continue;
            if (limits.min !== undefined && value < limits.min - 1e-9) {
                active.set(mate.id, { side: "min", value: limits.min });
                changed = true;
            } else if (limits.max !== undefined && value > limits.max + 1e-9) {
                active.set(mate.id, { side: "max", value: limits.max });
                changed = true;
            }
        }
        if (!changed) break;
    }

    // Reports.
    const reports: MateReport[] = [];
    for (const mate of mates) {
        if (!valid.includes(mate)) {
            reports.push({ id: mate.id, residual: Number.POSITIVE_INFINITY, satisfied: false });
            continue;
        }
        const out: number[] = [];
        const a = state.frameOf(mate.a);
        const b = state.frameOf(mate.b);
        mateResiduals(mate, a, b, problem.length, active.get(mate.id), out);
        const residual = maxAbs(out);
        reports.push({
            id: mate.id,
            residual,
            satisfied: residual <= tolerance,
            limitActive: active.get(mate.id)?.side,
            value: mateValue(mate.type, a, mateTarget(mate, a), b),
        });
    }
    const failingMates = [
        ...invalid,
        ...reports.filter((r) => !r.satisfied && !invalid.includes(r.id)).map((r) => r.id),
    ];

    // Degrees of freedom at the solution: every non-grounded instance counts, mated or not.
    const movable = instances.filter((x) => !x.grounded).map((x) => x.id);
    const dofProblem: Problem = {
        ...problem,
        free: movable,
        index: new Map(movable.map((id, i) => [id, i])),
    };
    const rows = residualVector(dofProblem, state, active, undefined).length;
    const cols = movable.length * 6;
    const j = rows === 0 ? [] : jacobian(dofProblem, state.clone(), active, undefined, rows);
    const { rank: jRank, nullSpace } =
        rows === 0 ? { rank: 0, nullSpace: identityColumns(cols) } : rankAndNullSpace(j, cols, 1e-6);
    const instanceDof = new Map<string, number>();
    movable.forEach((id, i) => {
        const block = nullSpace.slice(i * 6, i * 6 + 6);
        instanceDof.set(
            id,
            block.length === 0 || nullSpace[0]?.length === 0 ? 0 : rank(block, block[0].length, 1e-6),
        );
    });
    const nominal = valid.reduce((sum, m) => sum + MATE_DOF_REMOVED[m.type] + (active.has(m.id) ? 1 : 0), 0);
    const redundant = Math.max(0, nominal - jRank);
    const dof = cols - jRank;

    const roots = components(instances, valid);
    const groundedRoots = new Set([...grounded].map((id) => roots.get(id)));
    const floating = instances
        .filter((x) => !x.grounded && !groundedRoots.has(roots.get(x.id)))
        .map((x) => x.id);

    const status: SolveStatus = failingMates.length > 0 ? "conflicting" : "solved";
    return {
        transforms: state.transforms,
        status,
        iterations,
        mates: reports,
        failingMates,
        dof,
        instanceDof,
        redundant,
        overConstrained: failingMates.length > 0 || redundant > 0,
        underConstrained: dof > 0,
        floating,
    };
}

function identityColumns(n: number): Matrix {
    return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, k) => (i === k ? 1 : 0)));
}
