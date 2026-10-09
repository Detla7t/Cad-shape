// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Metadata for the functions of the formula library (`formulaLibrary.ts`,
 * `formulaArrays.ts`), in the tuple shape of FUNCTION_INFO: parameters, a one-line
 * description, the minimum and the maximum number of arguments (absent: any number). The
 * engine enforces the counts, the editor shows the rest. One row per function:
 * `NAME | parameters | description | min | max | category`.
 */

type Info = readonly [parameters: string, description: string, min: number, max?: number];

const TABLE = `
CEILING | number, [significance] | Rounds a number up to the nearest multiple of significance. | 1 | 2 | Math & trig
CEILING.MATH | number, [significance], [mode] | Rounds a number up to the nearest integer or multiple. | 1 | 3 | Math & trig
CEILING.PRECISE | number, [significance] | Rounds a number up, regardless of sign, to the nearest multiple. | 1 | 2 | Math & trig
FLOOR | number, [significance] | Rounds a number down toward zero to the nearest multiple of significance. | 1 | 2 | Math & trig
FLOOR.MATH | number, [significance], [mode] | Rounds a number down to the nearest integer or multiple. | 1 | 3 | Math & trig
FLOOR.PRECISE | number, [significance] | Rounds a number down, regardless of sign, to the nearest multiple. | 1 | 2 | Math & trig
MROUND | number, multiple | Rounds a number to the nearest multiple. | 2 | 2 | Math & trig
EVEN | number | Rounds a number up to the nearest even integer. | 1 | 1 | Math & trig
ODD | number | Rounds a number up to the nearest odd integer. | 1 | 1 | Math & trig
FACT | number | Returns the factorial of a number. | 1 | 1 | Math & trig
FACTDOUBLE | number | Returns the double factorial of a number. | 1 | 1 | Math & trig
COMBIN | number, number_chosen | Returns the number of combinations without repetition. | 2 | 2 | Math & trig
COMBINA | number, number_chosen | Returns the number of combinations with repetition. | 2 | 2 | Math & trig
PERMUT | number, number_chosen | Returns the number of permutations. | 2 | 2 | Statistical
GCD | number1, [number2], … | Returns the greatest common divisor. | 1 | | Math & trig
LCM | number1, [number2], … | Returns the least common multiple. | 1 | | Math & trig
QUOTIENT | numerator, denominator | Returns the integer part of a division. | 2 | 2 | Math & trig
RAND | | Returns a random number between 0 and 1. | 0 | 0 | Math & trig
RANDBETWEEN | bottom, top | Returns a random integer between two numbers. | 2 | 2 | Math & trig
RANDARRAY | [rows], [columns], [min], [max], [whole_number] | Returns an array of random numbers. | 0 | 5 | Array
SUMSQ | number1, [number2], … | Returns the sum of the squares. | 1 | | Math & trig
SUMX2MY2 | array_x, array_y | Sums the differences of squares of matching values. | 2 | 2 | Math & trig
SUMX2PY2 | array_x, array_y | Sums the sums of squares of matching values. | 2 | 2 | Math & trig
SUMXMY2 | array_x, array_y | Sums the squares of differences of matching values. | 2 | 2 | Math & trig
SINH | number | Returns the hyperbolic sine. | 1 | 1 | Math & trig
COSH | number | Returns the hyperbolic cosine. | 1 | 1 | Math & trig
TANH | number | Returns the hyperbolic tangent. | 1 | 1 | Math & trig
ASINH | number | Returns the inverse hyperbolic sine. | 1 | 1 | Math & trig
ACOSH | number | Returns the inverse hyperbolic cosine. | 1 | 1 | Math & trig
ATANH | number | Returns the inverse hyperbolic tangent. | 1 | 1 | Math & trig
COT | number | Returns the cotangent of an angle in radians. | 1 | 1 | Math & trig
SEC | number | Returns the secant of an angle in radians. | 1 | 1 | Math & trig
CSC | number | Returns the cosecant of an angle in radians. | 1 | 1 | Math & trig
SQRTPI | number | Returns the square root of number × π. | 1 | 1 | Math & trig
BASE | number, radix, [min_length] | Converts a number to text in another base. | 2 | 3 | Math & trig
DECIMAL | text, radix | Converts text in another base to a decimal number. | 2 | 2 | Math & trig
SUBTOTAL | function_num, ref1, [ref2], … | Returns a subtotal (1 AVERAGE, 2 COUNT, 3 COUNTA, 4 MAX, 5 MIN, 6 PRODUCT, 7/8 STDEV, 9 SUM, 10/11 VAR). | 2 | | Math & trig
AGGREGATE | function_num, options, array, [k] | Returns an aggregate, optionally ignoring errors. | 3 | 4 | Math & trig
AVERAGEA | value1, [value2], … | Averages values, counting text as 0 and TRUE as 1. | 1 | | Statistical
MAXA | value1, [value2], … | Returns the largest value, counting text as 0 and TRUE as 1. | 1 | | Statistical
MINA | value1, [value2], … | Returns the smallest value, counting text as 0 and TRUE as 1. | 1 | | Statistical
LARGE | array, k | Returns the k-th largest value. | 2 | 2 | Statistical
SMALL | array, k | Returns the k-th smallest value. | 2 | 2 | Statistical
RANK | number, ref, [order] | Returns the rank of a number in a list. | 2 | 3 | Statistical
RANK.EQ | number, ref, [order] | Returns the rank of a number; ties share the top rank. | 2 | 3 | Statistical
RANK.AVG | number, ref, [order] | Returns the rank of a number; ties share the average rank. | 2 | 3 | Statistical
STDEV | number1, [number2], … | Estimates the standard deviation of a sample. | 1 | | Statistical
STDEV.S | number1, [number2], … | Estimates the standard deviation of a sample. | 1 | | Statistical
STDEVP | number1, [number2], … | Returns the standard deviation of a population. | 1 | | Statistical
STDEV.P | number1, [number2], … | Returns the standard deviation of a population. | 1 | | Statistical
STDEVA | value1, [value2], … | Estimates the standard deviation, counting text as 0 and TRUE as 1. | 1 | | Statistical
VAR | number1, [number2], … | Estimates the variance of a sample. | 1 | | Statistical
VAR.S | number1, [number2], … | Estimates the variance of a sample. | 1 | | Statistical
VARP | number1, [number2], … | Returns the variance of a population. | 1 | | Statistical
VAR.P | number1, [number2], … | Returns the variance of a population. | 1 | | Statistical
MODE | number1, [number2], … | Returns the most frequent value. | 1 | | Statistical
MODE.SNGL | number1, [number2], … | Returns the most frequent value. | 1 | | Statistical
PERCENTILE | array, k | Returns the k-th percentile (0 to 1, inclusive). | 2 | 2 | Statistical
PERCENTILE.INC | array, k | Returns the k-th percentile (0 to 1, inclusive). | 2 | 2 | Statistical
PERCENTILE.EXC | array, k | Returns the k-th percentile (0 to 1, exclusive). | 2 | 2 | Statistical
QUARTILE | array, quart | Returns a quartile (0 to 4). | 2 | 2 | Statistical
QUARTILE.INC | array, quart | Returns a quartile (0 to 4). | 2 | 2 | Statistical
QUARTILE.EXC | array, quart | Returns a quartile (1 to 3, exclusive). | 2 | 2 | Statistical
PERCENTRANK | array, x, [significance] | Returns the percentage rank of a value. | 2 | 3 | Statistical
PERCENTRANK.INC | array, x, [significance] | Returns the percentage rank of a value (inclusive). | 2 | 3 | Statistical
GEOMEAN | number1, [number2], … | Returns the geometric mean. | 1 | | Statistical
HARMEAN | number1, [number2], … | Returns the harmonic mean. | 1 | | Statistical
AVEDEV | number1, [number2], … | Returns the average absolute deviation from the mean. | 1 | | Statistical
DEVSQ | number1, [number2], … | Returns the sum of squared deviations from the mean. | 1 | | Statistical
CORREL | array1, array2 | Returns the correlation coefficient of two data sets. | 2 | 2 | Statistical
PEARSON | array1, array2 | Returns the Pearson correlation coefficient. | 2 | 2 | Statistical
RSQ | known_ys, known_xs | Returns the square of the correlation coefficient. | 2 | 2 | Statistical
COVARIANCE.S | array1, array2 | Returns the sample covariance. | 2 | 2 | Statistical
COVARIANCE.P | array1, array2 | Returns the population covariance. | 2 | 2 | Statistical
COVAR | array1, array2 | Returns the population covariance. | 2 | 2 | Statistical
SLOPE | known_ys, known_xs | Returns the slope of the linear regression line. | 2 | 2 | Statistical
INTERCEPT | known_ys, known_xs | Returns the intercept of the linear regression line. | 2 | 2 | Statistical
FORECAST | x, known_ys, known_xs | Predicts a value along a linear trend. | 3 | 3 | Statistical
FORECAST.LINEAR | x, known_ys, known_xs | Predicts a value along a linear trend. | 3 | 3 | Statistical
STANDARDIZE | x, mean, standard_dev | Returns a normalized value (z-score). | 3 | 3 | Statistical
NORM.DIST | x, mean, standard_dev, cumulative | Returns the normal distribution. | 4 | 4 | Statistical
NORMDIST | x, mean, standard_dev, cumulative | Returns the normal distribution. | 4 | 4 | Statistical
NORM.S.DIST | z, [cumulative] | Returns the standard normal distribution. | 1 | 2 | Statistical
NORMSDIST | z | Returns the standard normal cumulative distribution. | 1 | 1 | Statistical
NORM.INV | probability, mean, standard_dev | Returns the inverse of the normal cumulative distribution. | 3 | 3 | Statistical
NORMINV | probability, mean, standard_dev | Returns the inverse of the normal cumulative distribution. | 3 | 3 | Statistical
NORM.S.INV | probability | Returns the inverse of the standard normal cumulative distribution. | 1 | 1 | Statistical
NORMSINV | probability | Returns the inverse of the standard normal cumulative distribution. | 1 | 1 | Statistical
COUNTUNIQUE | value1, [value2], … | Counts distinct nonempty values. | 1 | | Statistical
XOR | logical1, [logical2], … | TRUE when an odd number of conditions are true. | 1 | | Logical
SWITCH | expression, value1, result1, …, [default] | Returns the result matching the first equal value. | 3 | | Logical
CHOOSE | index_num, value1, [value2], … | Returns the value at a position in the list. | 2 | | Lookup & reference
LET | name1, value1, …, calculation | Names intermediate results for the final calculation. | 3 | | Logical
LAMBDA | [parameter1], …, calculation | Creates a function from parameters and a calculation. | 1 | | Logical
MAP | array1, [array2], …, lambda | Applies a LAMBDA to each value of the arrays. | 2 | | Logical
BYROW | array, lambda | Applies a LAMBDA to each row, one result per row. | 2 | 2 | Logical
BYCOL | array, lambda | Applies a LAMBDA to each column, one result per column. | 2 | 2 | Logical
REDUCE | initial_value, array, lambda | Accumulates the array's values through a LAMBDA. | 3 | 3 | Logical
SCAN | initial_value, array, lambda | Returns each intermediate value of a REDUCE. | 3 | 3 | Logical
MAKEARRAY | rows, columns, lambda | Builds an array by calling a LAMBDA with each row and column number. | 3 | 3 | Logical
ISERR | value | TRUE for any error except #N/A. | 1 | 1 | Information
ISLOGICAL | value | TRUE for TRUE or FALSE. | 1 | 1 | Information
ISNONTEXT | value | TRUE when the value is not text. | 1 | 1 | Information
ISEVEN | number | TRUE when the number is even. | 1 | 1 | Information
ISODD | number | TRUE when the number is odd. | 1 | 1 | Information
ISREF | value | TRUE when the argument is a reference. | 1 | 1 | Information
ISFORMULA | reference | TRUE when the referenced cell holds a formula. | 1 | 1 | Information
ERROR.TYPE | error_val | Returns the number of an error type. | 1 | 1 | Information
TYPE | value | Returns the type of a value (1 number, 2 text, 4 logical, 16 error, 64 array). | 1 | 1 | Information
N | value | Converts a value to a number. | 1 | 1 | Information
T | value | Returns the text of a value, or empty text. | 1 | 1 | Text
HYPERLINK | link_location, [friendly_name] | Shows a link's friendly name. | 1 | 2 | Lookup & reference
CHAR | number | Returns the character with a code (1–255). | 1 | 1 | Text
CODE | text | Returns the code of the first character. | 1 | 1 | Text
UNICHAR | number | Returns the Unicode character of a code point. | 1 | 1 | Text
UNICODE | text | Returns the code point of the first character. | 1 | 1 | Text
REPLACE | old_text, start_num, num_chars, new_text | Replaces part of a text by position. | 4 | 4 | Text
FIXED | number, [decimals], [no_commas] | Formats a number as text with fixed decimals. | 1 | 3 | Text
DOLLAR | number, [decimals] | Formats a number as currency text. | 1 | 2 | Text
NUMBERVALUE | text, [decimal_separator], [group_separator] | Converts locale-formatted text to a number. | 1 | 3 | Text
TEXTBEFORE | text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found] | Returns the text before a delimiter. | 2 | 6 | Text
TEXTAFTER | text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found] | Returns the text after a delimiter. | 2 | 6 | Text
TEXTSPLIT | text, col_delimiter, [row_delimiter], [ignore_empty], [match_mode], [pad_with] | Splits text into columns and rows. | 2 | 6 | Text
ARRAYTOTEXT | array, [format] | Returns an array's values as text. | 1 | 2 | Text
VALUETOTEXT | value, [format] | Returns a value as text. | 1 | 2 | Text
REGEXTEST | text, pattern, [case_sensitivity] | TRUE when the text matches a regular expression. | 2 | 3 | Text
REGEXEXTRACT | text, pattern, [return_mode], [case_sensitivity] | Returns the first match of a regular expression. | 2 | 4 | Text
REGEXREPLACE | text, pattern, replacement, [occurrence], [case_sensitivity] | Replaces matches of a regular expression. | 3 | 5 | Text
WEEKDAY | serial_number, [return_type] | Returns the day of the week (1 = Sunday by default). | 1 | 2 | Date & time
WEEKNUM | serial_number, [return_type] | Returns the week number of the year. | 1 | 2 | Date & time
ISOWEEKNUM | date | Returns the ISO week number of the year. | 1 | 1 | Date & time
NETWORKDAYS | start_date, end_date, [holidays] | Counts working days between two dates. | 2 | 3 | Date & time
NETWORKDAYS.INTL | start_date, end_date, [weekend], [holidays] | Counts working days with custom weekends. | 2 | 4 | Date & time
WORKDAY | start_date, days, [holidays] | Returns the date a number of working days away. | 2 | 3 | Date & time
WORKDAY.INTL | start_date, days, [weekend], [holidays] | Returns the date a number of working days away, with custom weekends. | 2 | 4 | Date & time
DATEDIF | start_date, end_date, unit | Returns the years ("Y"), months ("M") or days ("D") between dates. | 3 | 3 | Date & time
DATEVALUE | date_text | Converts a date written as text to a date serial. | 1 | 1 | Date & time
TIMEVALUE | time_text | Converts a time written as text to a fraction of a day. | 1 | 1 | Date & time
YEARFRAC | start_date, end_date, [basis] | Returns the fraction of a year between two dates. | 2 | 3 | Date & time
DAYS360 | start_date, end_date, [method] | Returns the days between dates on a 360-day year. | 2 | 3 | Date & time
PMT | rate, nper, pv, [fv], [type] | Returns the periodic payment of a loan or annuity. | 3 | 5 | Financial
FV | rate, nper, pmt, [pv], [type] | Returns the future value of an investment. | 3 | 5 | Financial
PV | rate, nper, pmt, [fv], [type] | Returns the present value of an investment. | 3 | 5 | Financial
NPER | rate, pmt, pv, [fv], [type] | Returns the number of periods of an investment. | 3 | 5 | Financial
RATE | nper, pmt, pv, [fv], [type], [guess] | Returns the interest rate per period. | 3 | 6 | Financial
IPMT | rate, per, nper, pv, [fv], [type] | Returns the interest part of a payment. | 4 | 6 | Financial
PPMT | rate, per, nper, pv, [fv], [type] | Returns the principal part of a payment. | 4 | 6 | Financial
CUMIPMT | rate, nper, pv, start_period, end_period, type | Returns the interest paid between two periods. | 6 | 6 | Financial
CUMPRINC | rate, nper, pv, start_period, end_period, type | Returns the principal paid between two periods. | 6 | 6 | Financial
NPV | rate, value1, [value2], … | Returns the net present value of periodic cash flows. | 2 | | Financial
XNPV | rate, values, dates | Returns the net present value of dated cash flows. | 3 | 3 | Financial
IRR | values, [guess] | Returns the internal rate of return of periodic cash flows. | 1 | 2 | Financial
XIRR | values, dates, [guess] | Returns the internal rate of return of dated cash flows. | 2 | 3 | Financial
MIRR | values, finance_rate, reinvest_rate | Returns the modified internal rate of return. | 3 | 3 | Financial
SLN | cost, salvage, life | Returns straight-line depreciation for one period. | 3 | 3 | Financial
SYD | cost, salvage, life, per | Returns sum-of-years' digits depreciation. | 4 | 4 | Financial
DDB | cost, salvage, life, period, [factor] | Returns double-declining balance depreciation. | 4 | 5 | Financial
DB | cost, salvage, life, period, [month] | Returns fixed-declining balance depreciation. | 4 | 5 | Financial
EFFECT | nominal_rate, npery | Returns the effective annual interest rate. | 2 | 2 | Financial
NOMINAL | effect_rate, npery | Returns the nominal annual interest rate. | 2 | 2 | Financial
FVSCHEDULE | principal, schedule | Returns the future value after a series of rates. | 2 | 2 | Financial
PDURATION | rate, pv, fv | Returns the periods needed to reach a value. | 3 | 3 | Financial
RRI | nper, pv, fv | Returns the equivalent interest rate for growth. | 3 | 3 | Financial
BIN2DEC | number | Converts binary to decimal. | 1 | 1 | Engineering
OCT2DEC | number | Converts octal to decimal. | 1 | 1 | Engineering
HEX2DEC | number | Converts hexadecimal to decimal. | 1 | 1 | Engineering
DEC2BIN | number, [places] | Converts decimal to binary. | 1 | 2 | Engineering
DEC2OCT | number, [places] | Converts decimal to octal. | 1 | 2 | Engineering
DEC2HEX | number, [places] | Converts decimal to hexadecimal. | 1 | 2 | Engineering
DELTA | number1, [number2] | 1 when two numbers are equal, else 0. | 1 | 2 | Engineering
GESTEP | number, [step] | 1 when the number is at least the step, else 0. | 1 | 2 | Engineering
XMATCH | lookup_value, lookup_array, [match_mode], [search_mode] | Returns the position of a value in a row or column. | 2 | 4 | Lookup & reference
LOOKUP | lookup_value, lookup_vector, [result_vector] | Looks up a value in a sorted row or column. | 2 | 3 | Lookup & reference
ROW | [reference] | Returns the row number of a reference. | 0 | 1 | Lookup & reference
COLUMN | [reference] | Returns the column number of a reference. | 0 | 1 | Lookup & reference
ROWS | array | Returns the number of rows. | 1 | 1 | Lookup & reference
COLUMNS | array | Returns the number of columns. | 1 | 1 | Lookup & reference
OFFSET | reference, rows, cols, [height], [width] | Returns a range offset from a reference. | 3 | 5 | Lookup & reference
INDIRECT | ref_text, [a1] | Returns the reference named by a text. | 1 | 2 | Lookup & reference
ADDRESS | row_num, column_num, [abs_num], [a1], [sheet_text] | Returns a cell address as text. | 2 | 5 | Lookup & reference
FORMULATEXT | reference | Returns a cell's formula as text. | 1 | 1 | Lookup & reference
TRANSPOSE | array | Swaps an array's rows and columns. | 1 | 1 | Array
FILTER | array, include, [if_empty] | Returns the rows (or columns) that meet a condition. | 2 | 3 | Array
SORT | array, [sort_index], [sort_order], [by_col] | Sorts an array. | 1 | 4 | Array
SORTBY | array, by_array1, [sort_order1], … | Sorts an array by other arrays. | 2 | | Array
UNIQUE | array, [by_col], [exactly_once] | Returns the distinct rows (or columns) of an array. | 1 | 3 | Array
SEQUENCE | rows, [columns], [start], [step] | Returns an array of sequential numbers. | 1 | 4 | Array
TAKE | array, rows, [columns] | Returns rows or columns from the start (positive) or end (negative). | 2 | 3 | Array
DROP | array, rows, [columns] | Removes rows or columns from the start or end. | 2 | 3 | Array
CHOOSEROWS | array, row_num1, [row_num2], … | Returns the chosen rows of an array. | 2 | | Array
CHOOSECOLS | array, col_num1, [col_num2], … | Returns the chosen columns of an array. | 2 | | Array
VSTACK | array1, [array2], … | Stacks arrays vertically. | 1 | | Array
HSTACK | array1, [array2], … | Stacks arrays horizontally. | 1 | | Array
TOCOL | array, [ignore], [scan_by_column] | Returns an array as one column. | 1 | 3 | Array
TOROW | array, [ignore], [scan_by_column] | Returns an array as one row. | 1 | 3 | Array
WRAPROWS | vector, wrap_count, [pad_with] | Wraps a row or column into rows. | 2 | 3 | Array
WRAPCOLS | vector, wrap_count, [pad_with] | Wraps a row or column into columns. | 2 | 3 | Array
EXPAND | array, rows, [columns], [pad_with] | Expands an array to a size. | 2 | 4 | Array
`;

export const MORE_FUNCTION_INFO: Record<string, Info> = {};

/** Function name → browser category ("Math & trig", "Statistical", …, "Array"). */
export const MORE_FUNCTION_CATEGORIES: Record<string, string> = {};

for (const line of TABLE.split("\n")) {
    if (!line.trim()) continue;
    const [name, parameters, description, min, max, category] = line.split("|").map((part) => part.trim());
    MORE_FUNCTION_INFO[name] =
        max === ""
            ? [parameters, description, Number(min)]
            : [parameters, description, Number(min), Number(max)];
    MORE_FUNCTION_CATEGORIES[name] = category;
}
