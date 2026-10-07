// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * NC programs: the G-code reader (`readNcProgram`) for mills, 2D cutting tables, wire EDM
 * and printers in the dialects of the posts, re-posting a read program with any post, and
 * the NC Program document element (its node, view, importer and commands).
 */

export {
    type DwellUnits,
    detectNcDialect,
    dialectOfPost,
    NC_DIALECTS,
    type NcDialect,
    ncDialect,
    ncDialects,
} from "./dialects";
export { frameFromAxisByAxisXYZ, frameFromEulerZXZ } from "./interpreter";
export {
    evaluate as evaluateNcExpression,
    lexBlock as lexNcBlock,
    type NcBlock,
    type NcWord,
    parseExpressionText as parseNcExpression,
} from "./lexer";
export * from "./program";
export { programMoves, readNcProgram } from "./reader";
export {
    machineForPost,
    ncCamProgram,
    type RepostOptions,
    type RepostResult,
    repostNcProgram,
} from "./repost";
export { ASSUMED_RAPID_FEED, formatNcDuration, moveLength, ncStats } from "./stats";
