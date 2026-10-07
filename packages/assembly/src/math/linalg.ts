// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The small dense linear algebra the mate solver needs: a symmetric positive (semi)definite
 * solve for Levenberg–Marquardt steps, and a one-sided Jacobi SVD for the rank and null
 * space of the constraint Jacobian (degrees of freedom, redundancy). Matrices are row-major
 * `number[][]`; sizes are tens to a few hundreds, so clarity beats blocking.
 */

export type Matrix = number[][];

export function zeros(rows: number, cols: number): Matrix {
    return Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
}

/** Jᵀ J and Jᵀ r in one pass. */
export function normalEquations(jacobian: Matrix, residual: readonly number[], cols: number) {
    const jtj = zeros(cols, cols);
    const jtr = new Array<number>(cols).fill(0);
    for (let row = 0; row < jacobian.length; row++) {
        const line = jacobian[row];
        const r = residual[row];
        for (let i = 0; i < cols; i++) {
            const a = line[i];
            if (a === 0) continue;
            jtr[i] += a * r;
            const target = jtj[i];
            for (let j = i; j < cols; j++) target[j] += a * line[j];
        }
    }
    for (let i = 0; i < cols; i++) for (let j = 0; j < i; j++) jtj[i][j] = jtj[j][i];
    return { jtj, jtr };
}

/**
 * Solves `a x = b` by Gaussian elimination with partial pivoting. Returns undefined for a
 * (numerically) singular system.
 */
export function solveLinear(a: Matrix, b: readonly number[]): number[] | undefined {
    const n = b.length;
    const m = a.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
        }
        if (Math.abs(m[pivot][col]) < 1e-300) return undefined;
        if (pivot !== col) [m[pivot], m[col]] = [m[col], m[pivot]];
        const lead = m[col];
        for (let row = col + 1; row < n; row++) {
            const factor = m[row][col] / lead[col];
            if (factor === 0) continue;
            const target = m[row];
            for (let k = col; k <= n; k++) target[k] -= factor * lead[k];
        }
    }
    const x = new Array<number>(n).fill(0);
    for (let row = n - 1; row >= 0; row--) {
        let sum = m[row][n];
        for (let k = row + 1; k < n; k++) sum -= m[row][k] * x[k];
        x[row] = sum / m[row][row];
    }
    return x.every(Number.isFinite) ? x : undefined;
}

export interface Svd {
    /** Singular values, one per column of the input (unsorted, matching `v`'s columns). */
    readonly values: number[];
    /** Right singular vectors as columns: `v[i][k]` is component i of vector k. */
    readonly v: Matrix;
}

/**
 * One-sided Jacobi SVD (Hestenes): orthogonalizes the columns of `a` (m×n, any shape) by plane
 * rotations accumulated into V. Afterwards `a V = U Σ`, the column norms are the singular
 * values and V's columns the right singular vectors — what rank and null space need.
 */
export function svd(a: Matrix, cols: number): Svd {
    const rows = a.length;
    const u = a.map((row) => [...row]);
    const v = zeros(cols, cols);
    for (let i = 0; i < cols; i++) v[i][i] = 1;
    for (let sweep = 0; sweep < 60; sweep++) {
        let rotated = false;
        for (let p = 0; p < cols - 1; p++) {
            for (let q = p + 1; q < cols; q++) {
                let alpha = 0;
                let beta = 0;
                let gamma = 0;
                for (let k = 0; k < rows; k++) {
                    const up = u[k][p];
                    const uq = u[k][q];
                    alpha += up * up;
                    beta += uq * uq;
                    gamma += up * uq;
                }
                if (Math.abs(gamma) <= 1e-15 * Math.sqrt(alpha * beta) || gamma === 0) continue;
                rotated = true;
                const zeta = (beta - alpha) / (2 * gamma);
                const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
                const c = 1 / Math.sqrt(1 + t * t);
                const s = c * t;
                for (let k = 0; k < rows; k++) {
                    const up = u[k][p];
                    const uq = u[k][q];
                    u[k][p] = c * up - s * uq;
                    u[k][q] = s * up + c * uq;
                }
                for (let k = 0; k < cols; k++) {
                    const vp = v[k][p];
                    const vq = v[k][q];
                    v[k][p] = c * vp - s * vq;
                    v[k][q] = s * vp + c * vq;
                }
            }
        }
        if (!rotated) break;
    }
    const values = new Array<number>(cols).fill(0);
    for (let j = 0; j < cols; j++) {
        let sum = 0;
        for (let k = 0; k < rows; k++) sum += u[k][j] * u[k][j];
        values[j] = Math.sqrt(sum);
    }
    return { values, v };
}

/** Rank and null-space basis (columns) of an m×n matrix, singular values below `relTol·σmax` counting as zero. */
export function rankAndNullSpace(
    a: Matrix,
    cols: number,
    relTol = 1e-7,
): { rank: number; nullSpace: Matrix } {
    if (cols === 0) return { rank: 0, nullSpace: [] };
    const { values, v } = svd(a, cols);
    const max = Math.max(1, ...values);
    const zero = values.map((value) => value <= relTol * max);
    const rank = zero.filter((x) => !x).length;
    const nullCols = zero.flatMap((isZero, index) => (isZero ? [index] : []));
    const nullSpace = v.map((row) => nullCols.map((col) => row[col]));
    return { rank, nullSpace };
}

/** Rank of a small matrix given as rows (null-space projection blocks). */
export function rank(a: Matrix, cols: number, relTol = 1e-7): number {
    if (a.length === 0 || cols === 0) return 0;
    // Rank of A equals the rank of Aᵀ; feed the narrower orientation to the SVD.
    return rankAndNullSpace(a, cols, relTol).rank;
}
