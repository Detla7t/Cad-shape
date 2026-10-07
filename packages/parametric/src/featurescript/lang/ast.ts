// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { SourcePosition } from "./errors";

/**
 * The FeatureScript syntax tree. Node kinds mirror the language reference closely
 * enough that the interpreter is a direct walk; anything purely syntactic (the
 * `FeatureScript 1234;` header, import versions) is kept only for diagnostics.
 */

interface NodeBase {
    readonly pos: SourcePosition;
}

// ------------------------------------------------------------------ Expressions

export type Expression =
    | NumberLiteral
    | StringLiteral
    | BooleanLiteral
    | UndefinedLiteral
    | Identifier
    | ArrayLiteral
    | MapLiteral
    | FunctionExpression
    | UnaryExpression
    | BinaryExpression
    | LogicalExpression
    | ConditionalExpression
    | IsExpression
    | AsExpression
    | CallExpression
    | MemberExpression
    | IndexExpression
    | BoxDereference
    | NewBoxExpression
    | AssignmentExpression
    | TryExpression
    | BuiltinReference;

export interface NumberLiteral extends NodeBase {
    readonly kind: "Number";
    readonly value: number;
}

export interface StringLiteral extends NodeBase {
    readonly kind: "String";
    readonly value: string;
}

export interface BooleanLiteral extends NodeBase {
    readonly kind: "Boolean";
    readonly value: boolean;
}

export interface UndefinedLiteral extends NodeBase {
    readonly kind: "Undefined";
}

/** A name, optionally namespace-qualified (`Std::qEverything`). */
export interface Identifier extends NodeBase {
    readonly kind: "Identifier";
    readonly name: string;
    readonly namespace?: string;
}

export interface ArrayLiteral extends NodeBase {
    readonly kind: "Array";
    readonly elements: Expression[];
}

export interface MapEntry {
    readonly key: Expression;
    readonly value: Expression;
}

export interface MapLiteral extends NodeBase {
    readonly kind: "Map";
    readonly entries: MapEntry[];
}

export interface Parameter {
    readonly name: string;
    readonly type?: TypeReference;
    readonly pos: SourcePosition;
}

export interface TypeReference {
    readonly name: string;
    readonly namespace?: string;
    readonly pos: SourcePosition;
}

export interface FunctionExpression extends NodeBase {
    readonly kind: "Function";
    readonly name?: string;
    readonly params: Parameter[];
    readonly returns?: TypeReference;
    readonly precondition?: Block;
    readonly body: Block;
}

export type UnaryOperator = "-" | "+" | "!";

export interface UnaryExpression extends NodeBase {
    readonly kind: "Unary";
    readonly operator: UnaryOperator;
    readonly operand: Expression;
}

export type BinaryOperator = "+" | "-" | "*" | "/" | "%" | "^" | "~" | "==" | "!=" | "<" | ">" | "<=" | ">=";

export interface BinaryExpression extends NodeBase {
    readonly kind: "Binary";
    readonly operator: BinaryOperator;
    readonly left: Expression;
    readonly right: Expression;
}

export interface LogicalExpression extends NodeBase {
    readonly kind: "Logical";
    readonly operator: "&&" | "||";
    readonly left: Expression;
    readonly right: Expression;
}

export interface ConditionalExpression extends NodeBase {
    readonly kind: "Conditional";
    readonly test: Expression;
    readonly consequent: Expression;
    readonly alternate: Expression;
}

export interface IsExpression extends NodeBase {
    readonly kind: "Is";
    readonly value: Expression;
    readonly type: TypeReference;
}

export interface AsExpression extends NodeBase {
    readonly kind: "As";
    readonly value: Expression;
    readonly type: TypeReference;
}

export interface CallExpression extends NodeBase {
    readonly kind: "Call";
    readonly callee: Expression;
    readonly args: Expression[];
}

export interface MemberExpression extends NodeBase {
    readonly kind: "Member";
    readonly object: Expression;
    readonly property: string;
}

export interface IndexExpression extends NodeBase {
    readonly kind: "Index";
    readonly object: Expression;
    readonly index: Expression;
}

/** `b[]` — reads (or, as an assignment target, writes) the contents of a box. */
export interface BoxDereference extends NodeBase {
    readonly kind: "BoxDeref";
    readonly object: Expression;
}

export interface NewBoxExpression extends NodeBase {
    readonly kind: "NewBox";
    readonly value: Expression;
}

export type AssignmentOperator = "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "^=" | "~=" | "||=" | "&&=";

export interface AssignmentExpression extends NodeBase {
    readonly kind: "Assignment";
    readonly operator: AssignmentOperator;
    readonly target: Expression;
    readonly value: Expression;
}

/** `try(expr)` / `try silent(expr)` — the value, or undefined when evaluating it threw. */
export interface TryExpression extends NodeBase {
    readonly kind: "TryExpression";
    readonly silent: boolean;
    readonly value: Expression;
}

/** `@opExtrude` — a direct reference to a built-in, bypassing any user shadowing. */
export interface BuiltinReference extends NodeBase {
    readonly kind: "Builtin";
    readonly name: string;
}

// ------------------------------------------------------------------ Statements

export type Statement =
    | Block
    | ExpressionStatement
    | VariableDeclaration
    | IfStatement
    | ForStatement
    | ForInStatement
    | WhileStatement
    | DoWhileStatement
    | ReturnStatement
    | BreakStatement
    | ContinueStatement
    | ThrowStatement
    | TryStatement
    | FunctionDeclaration
    | EmptyStatement;

/** Annotation maps preceding a statement; kept on the statement for precondition analysis. */
export interface Annotated {
    readonly annotations?: MapLiteral[];
}

export interface Block extends NodeBase, Annotated {
    readonly kind: "Block";
    readonly body: Statement[];
}

export interface ExpressionStatement extends NodeBase, Annotated {
    readonly kind: "ExpressionStatement";
    readonly expression: Expression;
}

export interface Declarator {
    readonly name: string;
    readonly type?: TypeReference;
    readonly init?: Expression;
    readonly pos: SourcePosition;
}

export interface VariableDeclaration extends NodeBase, Annotated {
    readonly kind: "VariableDeclaration";
    readonly constant: boolean;
    readonly declarations: Declarator[];
}

export interface IfStatement extends NodeBase, Annotated {
    readonly kind: "If";
    readonly test: Expression;
    readonly consequent: Statement;
    readonly alternate?: Statement;
}

export interface ForStatement extends NodeBase, Annotated {
    readonly kind: "For";
    readonly init?: VariableDeclaration | ExpressionStatement;
    readonly test?: Expression;
    readonly update?: Expression;
    readonly body: Statement;
}

/** `for (var x in array)` / `for (var key, value in map)`. */
export interface ForInStatement extends NodeBase, Annotated {
    readonly kind: "ForIn";
    readonly declares: boolean;
    readonly constant: boolean;
    readonly first: string;
    readonly second?: string;
    readonly iterable: Expression;
    readonly body: Statement;
}

export interface WhileStatement extends NodeBase, Annotated {
    readonly kind: "While";
    readonly test: Expression;
    readonly body: Statement;
}

export interface DoWhileStatement extends NodeBase, Annotated {
    readonly kind: "DoWhile";
    readonly test: Expression;
    readonly body: Statement;
}

export interface ReturnStatement extends NodeBase, Annotated {
    readonly kind: "Return";
    readonly value?: Expression;
}

export interface BreakStatement extends NodeBase, Annotated {
    readonly kind: "Break";
}

export interface ContinueStatement extends NodeBase, Annotated {
    readonly kind: "Continue";
}

export interface ThrowStatement extends NodeBase, Annotated {
    readonly kind: "Throw";
    readonly value: Expression;
}

export interface TryStatement extends NodeBase, Annotated {
    readonly kind: "Try";
    readonly silent: boolean;
    readonly block: Block;
    readonly param?: string;
    readonly handler?: Block;
}

export interface FunctionDeclaration extends NodeBase, Annotated {
    readonly kind: "FunctionDeclaration";
    readonly name: string;
    readonly fn: FunctionExpression;
}

export interface EmptyStatement extends NodeBase, Annotated {
    readonly kind: "Empty";
}

// ------------------------------------------------------------------ Top level

export type TopLevel =
    | ImportDeclaration
    | ConstDeclaration
    | TopFunctionDeclaration
    | PredicateDeclaration
    | OperatorDeclaration
    | TypeDeclaration
    | EnumDeclaration;

interface TopLevelBase extends NodeBase {
    readonly exported: boolean;
    readonly annotations: MapLiteral[];
}

export interface ImportDeclaration extends TopLevelBase {
    readonly kind: "Import";
    readonly path: string;
    readonly version?: string;
    /** `Foo::import(...)` binds the module's exports under the namespace `Foo`. */
    readonly namespace?: string;
}

export interface ConstDeclaration extends TopLevelBase {
    readonly kind: "Const";
    readonly name: string;
    readonly type?: TypeReference;
    readonly value: Expression;
}

export interface TopFunctionDeclaration extends TopLevelBase {
    readonly kind: "FunctionTop";
    readonly name: string;
    readonly fn: FunctionExpression;
}

/** A predicate is a function whose every statement must hold; it yields a boolean. */
export interface PredicateDeclaration extends TopLevelBase {
    readonly kind: "Predicate";
    readonly name: string;
    readonly params: Parameter[];
    readonly body: Block;
}

export interface OperatorDeclaration extends TopLevelBase {
    readonly kind: "Operator";
    readonly operator: string;
    readonly fn: FunctionExpression;
}

export interface TypeDeclaration extends TopLevelBase {
    readonly kind: "Type";
    readonly name: string;
    readonly typecheck: TypeReference;
}

export interface EnumMember {
    readonly name: string;
    readonly annotations: MapLiteral[];
    readonly pos: SourcePosition;
}

export interface EnumDeclaration extends TopLevelBase {
    readonly kind: "Enum";
    readonly name: string;
    readonly members: EnumMember[];
}

export interface Program {
    /** The `FeatureScript 1234;` header's version, when present. */
    readonly version?: number;
    readonly body: TopLevel[];
    readonly file: string;
}
