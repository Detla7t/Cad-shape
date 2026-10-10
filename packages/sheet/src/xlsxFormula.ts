// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Formula text as Excel stores it vs. as it is shown and edited. Functions added after
 * Excel 2007 are stored with a `_xlfn.` prefix (FILTER and SORT with `_xlfn._xlws.`), and
 * LET/LAMBDA parameters with `_xlpm.`; without the prefix Excel reads them as unknown
 * names (#NAME?). The model keeps the plain names; the prefixes are added back on write.
 */

/** Functions Excel stores as `_xlfn.NAME` (the "future functions" of Excel 2010 and later). */
const FUTURE_FUNCTIONS = new Set(
    (
        "ACOT ACOTH AGGREGATE ARABIC ARRAYTOTEXT BASE BETA.DIST BETA.INV BINOM.DIST BINOM.DIST.RANGE " +
        "BINOM.INV BITAND BITLSHIFT BITOR BITRSHIFT BITXOR BYCOL BYROW CEILING.MATH CEILING.PRECISE " +
        "CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT CHISQ.TEST CHOOSECOLS CHOOSEROWS COMBINA CONCAT " +
        "CONFIDENCE.NORM CONFIDENCE.T COT COTH COVARIANCE.P COVARIANCE.S CSC CSCH DAYS DECIMAL DROP " +
        "ENCODEURL ERF.PRECISE ERFC.PRECISE EXPAND EXPON.DIST F.DIST F.DIST.RT F.INV F.INV.RT F.TEST " +
        "FILTERXML FLOOR.MATH FLOOR.PRECISE FORECAST.ETS FORECAST.ETS.CONFINT FORECAST.ETS.SEASONALITY " +
        "FORECAST.ETS.STAT FORECAST.LINEAR FORMULATEXT GAMMA GAMMA.DIST GAMMA.INV GAMMALN.PRECISE GAUSS " +
        "GROUPBY HSTACK HYPGEOM.DIST IFNA IFS IMAGE IMCOSH IMCOT IMCSC IMCSCH IMSEC IMSECH IMSINH IMTAN " +
        "ISFORMULA ISOMITTED ISOWEEKNUM LAMBDA LET LOGNORM.DIST LOGNORM.INV MAKEARRAY MAP MAXIFS MINIFS " +
        "MODE.MULT MODE.SNGL MUNIT NEGBINOM.DIST NETWORKDAYS.INTL NORM.DIST NORM.INV NORM.S.DIST " +
        "NORM.S.INV NUMBERVALUE PDURATION PERCENTILE.EXC PERCENTILE.INC PERCENTOF PERCENTRANK.EXC " +
        "PERCENTRANK.INC PERMUTATIONA PHI PIVOTBY POISSON.DIST QUARTILE.EXC QUARTILE.INC RANDARRAY " +
        "RANK.AVG RANK.EQ REDUCE REGEXEXTRACT REGEXREPLACE REGEXTEST RRI SCAN SEC SECH SEQUENCE SHEET " +
        "SHEETS SINGLE SKEW.P SORTBY STDEV.P STDEV.S STOCKHISTORY SWITCH T.DIST T.DIST.2T T.DIST.RT T.INV " +
        "T.INV.2T T.TEST TAKE TEXTAFTER TEXTBEFORE TEXTJOIN TEXTSPLIT TOCOL TOROW TRIMRANGE UNICHAR " +
        "UNICODE UNIQUE VALUETOTEXT VAR.P VAR.S VSTACK WEBSERVICE WEIBULL.DIST WORKDAY.INTL WRAPCOLS " +
        "WRAPROWS XLOOKUP XMATCH XOR Z.TEST ANCHORARRAY"
    ).split(" "),
);
/** Functions Excel stores as `_xlfn._xlws.NAME`. */
const WORKSHEET_FUNCTIONS = new Set(["FILTER", "SORT"]);

/** Applies `replace` outside string literals, quoted sheet names and structured-reference brackets. */
function outsideLiterals(formula: string, replace: (code: string) => string): string {
    const tokens = /("(?:[^"]|"")*"|'(?:[^']|'')*'|\[(?:[^[\]]|\[[^\]]*\])*\])|[^"'[]+|["'[]/g;
    return formula.replace(tokens, (token, literal?: string) =>
        literal === undefined ? replace(token) : token,
    );
}

/** The formula as shown: file-format prefixes removed. */
export function stripFormulaPrefixes(formula: string): string {
    if (!formula.includes("_xl")) return formula;
    return outsideLiterals(formula, (code) => code.replace(/\b_xl(?:fn|ws|pm)\./gi, ""));
}

/** The formula as stored: `_xlfn.` / `_xlfn._xlws.` before newer functions, `_xlpm.` before LET/LAMBDA names. */
export function addFormulaPrefixes(formula: string): string {
    const prefixed = outsideLiterals(formula, (code) =>
        code.replace(/(?<![\w.[\]])([A-Za-z][\w.]*)(?=\s*\()/g, (name: string) => {
            const upper = name.toUpperCase();
            if (WORKSHEET_FUNCTIONS.has(upper)) return `_xlfn._xlws.${name}`;
            if (FUTURE_FUNCTIONS.has(upper)) return `_xlfn.${name}`;
            return name;
        }),
    );
    return /\b_xlfn\.(LET|LAMBDA)\(/i.test(prefixed) ? prefixLambdaParameters(prefixed) : prefixed;
}

/** LET's names and LAMBDA's parameters (and their uses) get `_xlpm.`. */
function prefixLambdaParameters(formula: string): string {
    const names = new Set<string>();
    const call = /\b_xlfn\.(LET|LAMBDA)\(/gi;
    for (let match = call.exec(formula); match; match = call.exec(formula)) {
        const args = topLevelArguments(formula, call.lastIndex);
        const declared =
            match[1].toUpperCase() === "LET"
                ? args.filter((_, i) => i % 2 === 0 && i < args.length - 1)
                : args.slice(0, -1);
        for (const arg of declared) if (/^[A-Za-z_][\w.]*$/.test(arg.trim())) names.add(arg.trim());
    }
    if (names.size === 0) return formula;
    return outsideLiterals(formula, (code) =>
        code.replace(/(?<![\w.[\]])([A-Za-z_][\w.]*)(?![\w.([!])/g, (name: string) =>
            names.has(name) ? `_xlpm.${name}` : name,
        ),
    );
}

function topLevelArguments(formula: string, start: number): string[] {
    const args: string[] = [];
    let depth = 0;
    let quote = "";
    let from = start;
    for (let i = start; i < formula.length; i++) {
        const ch = formula[i];
        if (quote) {
            if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") {
            if (depth === 0) {
                args.push(formula.slice(from, i));
                break;
            }
            depth--;
        } else if (ch === "," && depth === 0) {
            args.push(formula.slice(from, i));
            from = i + 1;
        }
    }
    return args;
}
