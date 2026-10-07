// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type {
    Annotated,
    AssignmentOperator,
    BinaryOperator,
    Block,
    Declarator,
    EnumMember,
    Expression,
    ExpressionStatement,
    FunctionExpression,
    MapEntry,
    MapLiteral,
    Parameter,
    Program,
    Statement,
    TopLevel,
    TypeReference,
    VariableDeclaration,
} from "./ast";
import { FsSyntaxError, type SourcePosition } from "./errors";
import { type Token, tokenize } from "./lexer";

/** Parses one FeatureScript module (a Feature Studio's source). Throws `FsSyntaxError`. */
export function parseProgram(source: string, file = "<studio>"): Program {
    return new Parser(tokenize(source, file), file).program();
}

/** Parses a standalone expression — used for parameter visibility conditions and tests. */
export function parseExpression(source: string, file = "<expression>"): Expression {
    const parser = new Parser(tokenize(source, file), file);
    const expression = parser.expressionOnly();
    return expression;
}

const ASSIGNMENT_OPERATORS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "^=", "~=", "||=", "&&="]);

/** Operators a user `operator` declaration may overload. */
const OVERLOADABLE = new Set(["+", "-", "*", "/", "%", "^", "<", "==", "!", "~"]);

/**
 * Recursive-descent parser. Precedence, loosest to tightest:
 * assignment, `?:`, `||`, `&&`, `== !=`, `< > <= >=`, `is`/`as`, `+ - ~`, `* / %`,
 * unary `- + !`, `^` (right-associative), then postfix calls, `.member`, `[index]`,
 * box dereference `[]`.
 */
class Parser {
    private index = 0;

    constructor(
        private readonly tokens: Token[],
        private readonly file: string,
    ) {}

    // ------------------------------------------------------------------ Token helpers

    private get current(): Token {
        return this.tokens[this.index];
    }

    private peek(offset = 1): Token {
        return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
    }

    private next(): Token {
        const token = this.tokens[this.index];
        if (token.kind !== "eof") this.index++;
        return token;
    }

    private is(text: string, token: Token = this.current): boolean {
        return (token.kind === "punct" || token.kind === "keyword") && token.text === text;
    }

    private accept(text: string): boolean {
        if (!this.is(text)) return false;
        this.next();
        return true;
    }

    private expect(text: string, what?: string): Token {
        if (!this.is(text)) {
            throw this.error(`Expected ${what ?? `"${text}"`} but found ${describe(this.current)}`);
        }
        return this.next();
    }

    private identifier(what = "an identifier"): Token {
        if (this.current.kind !== "identifier") {
            throw this.error(`Expected ${what} but found ${describe(this.current)}`);
        }
        return this.next();
    }

    private error(message: string, pos: SourcePosition = this.current.pos): FsSyntaxError {
        return new FsSyntaxError(message, pos);
    }

    // ------------------------------------------------------------------ Program

    program(): Program {
        let version: number | undefined;
        if (this.is("FeatureScript")) {
            this.next();
            const token = this.current;
            if (token.kind !== "number") throw this.error("Expected a version number after FeatureScript");
            version = this.next().value;
            this.expect(";");
        }
        const body: TopLevel[] = [];
        while (this.current.kind !== "eof") {
            if (this.accept(";")) continue;
            body.push(this.topLevel());
        }
        return { version, body, file: this.file };
    }

    expressionOnly(): Expression {
        const expression = this.expression();
        if (this.current.kind !== "eof") throw this.error(`Unexpected ${describe(this.current)}`);
        return expression;
    }

    private annotations(): MapLiteral[] {
        const result: MapLiteral[] = [];
        while (this.is("annotation")) {
            const pos = this.next().pos;
            if (!this.is("{")) throw this.error('Expected "{" after annotation', pos);
            result.push(this.mapLiteral());
        }
        return result;
    }

    private topLevel(): TopLevel {
        const annotations = this.annotations();
        const pos = this.current.pos;
        const exported = this.accept("export");

        if (this.is("import") || (this.current.kind === "identifier" && this.is("::", this.peek()))) {
            return this.importDeclaration(exported, annotations);
        }
        if (this.accept("const")) {
            const name = this.identifier("a constant name").text;
            const type = this.accept("is") ? this.typeReference() : undefined;
            this.expect("=");
            const value = this.expression();
            this.expect(";");
            return { kind: "Const", pos, exported, annotations, name, type, value };
        }
        if (this.is("function")) {
            this.next();
            const name = this.identifier("a function name").text;
            const fn = this.functionRest(pos, name);
            return { kind: "FunctionTop", pos, exported, annotations, name, fn };
        }
        if (this.accept("predicate")) {
            const name = this.identifier("a predicate name").text;
            const params = this.parameters();
            const precondition = this.accept("precondition") ? this.preconditionBody() : undefined;
            const body = this.block();
            return { kind: "Predicate", pos, exported, annotations, name, params, precondition, body };
        }
        if (this.accept("operator")) {
            const token = this.next();
            if (token.kind !== "punct" || !OVERLOADABLE.has(token.text)) {
                throw this.error(`Operator ${describe(token)} cannot be overloaded`, token.pos);
            }
            const fn = this.functionRest(pos, `operator${token.text}`);
            return { kind: "Operator", pos, exported, annotations, operator: token.text, fn };
        }
        if (this.accept("type")) {
            const name = this.identifier("a type name").text;
            this.expect("typecheck");
            const typecheck = this.typeReference();
            this.expect(";");
            return { kind: "Type", pos, exported, annotations, name, typecheck };
        }
        if (this.accept("enum")) return this.enumDeclaration(pos, exported, annotations);
        throw this.error(
            `Expected a top-level declaration (const, function, predicate, type, enum, import) but found ${describe(this.current)}`,
        );
    }

    private importDeclaration(exported: boolean, annotations: MapLiteral[]): TopLevel {
        const pos = this.current.pos;
        let namespace: string | undefined;
        if (this.current.kind === "identifier") {
            namespace = this.next().text;
            this.expect("::");
        }
        this.expect("import");
        this.expect("(");
        let path: string | undefined;
        let version: string | undefined;
        while (!this.is(")")) {
            const key = this.identifier("an import argument").text;
            this.expect(":");
            const value = this.next();
            if (value.kind !== "string") throw this.error(`Import ${key} must be a string`, value.pos);
            if (key === "path") path = value.text;
            else if (key === "version") version = value.text;
            else throw this.error(`Unknown import argument "${key}"`, value.pos);
            if (!this.accept(",")) break;
        }
        this.expect(")");
        this.expect(";");
        if (path === undefined) throw this.error("Import requires a path", pos);
        return { kind: "Import", pos, exported, annotations, path, version, namespace };
    }

    private enumDeclaration(pos: SourcePosition, exported: boolean, annotations: MapLiteral[]): TopLevel {
        const name = this.identifier("an enum name").text;
        this.expect("{");
        const members: EnumMember[] = [];
        while (!this.is("}")) {
            const memberAnnotations = this.annotations();
            const token = this.identifier("an enum value");
            members.push({ name: token.text, annotations: memberAnnotations, pos: token.pos });
            if (!this.accept(",")) break;
        }
        this.expect("}");
        return { kind: "Enum", pos, exported, annotations, name, members };
    }

    private typeReference(): TypeReference {
        const token = this.current;
        // Built-in type names are keywords in a few cases (`undefined`, `function`).
        if (token.kind === "keyword" && (token.text === "undefined" || token.text === "function")) {
            this.next();
            return { name: token.text, pos: token.pos };
        }
        const first = this.identifier("a type name");
        if (this.accept("::")) {
            const second = this.identifier("a type name");
            return { name: second.text, namespace: first.text, pos: first.pos };
        }
        return { name: first.text, pos: first.pos };
    }

    private parameters(): Parameter[] {
        this.expect("(");
        const params: Parameter[] = [];
        while (!this.is(")")) {
            const token = this.identifier("a parameter name");
            const type = this.accept("is") ? this.typeReference() : undefined;
            params.push({ name: token.text, type, pos: token.pos });
            if (!this.accept(",")) break;
        }
        this.expect(")");
        return params;
    }

    /** Everything after `function [name]`: parameters, `returns`, `precondition`, body. */
    private functionRest(pos: SourcePosition, name?: string): FunctionExpression {
        const params = this.parameters();
        const returns = this.accept("returns") ? this.typeReference() : undefined;
        const precondition = this.accept("precondition") ? this.preconditionBody() : undefined;
        const body = this.block();
        return { kind: "Function", pos, name, params, returns, precondition, body };
    }

    /** `precondition { ... }`, or the one-expression form `precondition a == b;`. */
    private preconditionBody(): Block {
        if (this.is("{")) return this.block();
        const pos = this.current.pos;
        const expression = this.expression();
        this.expect(";");
        return { kind: "Block", pos, body: [{ kind: "ExpressionStatement", pos, expression }] };
    }

    // ------------------------------------------------------------------ Statements

    private block(): Block {
        const pos = this.expect("{").pos;
        const body: Statement[] = [];
        while (!this.is("}")) {
            if (this.current.kind === "eof") throw this.error('Missing "}" to close the block', pos);
            body.push(this.statement());
        }
        this.expect("}");
        return { kind: "Block", pos, body };
    }

    private statement(): Statement {
        const annotations = this.annotations();
        const statement = this.bareStatement();
        return annotations.length > 0 ? ({ ...statement, annotations } as Statement & Annotated) : statement;
    }

    private bareStatement(): Statement {
        const token = this.current;
        const pos = token.pos;
        if (this.is("{")) return this.block();
        if (this.accept(";")) return { kind: "Empty", pos };
        if (this.is("var") || this.is("const")) {
            const declaration = this.variableDeclaration();
            this.expect(";");
            return declaration;
        }
        if (this.accept("if")) {
            this.expect("(");
            const test = this.expression();
            this.expect(")");
            const consequent = this.statement();
            const alternate = this.accept("else") ? this.statement() : undefined;
            return { kind: "If", pos, test, consequent, alternate };
        }
        if (this.accept("for")) return this.forStatement(pos);
        if (this.accept("while")) {
            this.expect("(");
            const test = this.expression();
            this.expect(")");
            return { kind: "While", pos, test, body: this.statement() };
        }
        if (this.accept("do")) {
            const body = this.statement();
            this.expect("while");
            this.expect("(");
            const test = this.expression();
            this.expect(")");
            this.expect(";");
            return { kind: "DoWhile", pos, test, body };
        }
        if (this.accept("return")) {
            const value = this.is(";") ? undefined : this.expression();
            this.expect(";");
            return { kind: "Return", pos, value };
        }
        if (this.accept("break")) {
            this.expect(";");
            return { kind: "Break", pos };
        }
        if (this.accept("continue")) {
            this.expect(";");
            return { kind: "Continue", pos };
        }
        if (this.accept("throw")) {
            const value = this.expression();
            this.expect(";");
            return { kind: "Throw", pos, value };
        }
        // `try {` / `try silent {` is the statement; `try(` / `try silent(` the expression.
        if (this.is("try") && (this.is("{", this.peek()) || this.isTrySilentBlock())) {
            return this.tryStatement(pos);
        }
        if (this.is("function") && this.peek().kind === "identifier") {
            this.next();
            const name = this.identifier().text;
            return { kind: "FunctionDeclaration", pos, name, fn: this.functionRest(pos, name) };
        }
        const expression = this.expression();
        this.expect(";", '";"');
        return { kind: "ExpressionStatement", pos, expression };
    }

    private isTrySilentBlock(): boolean {
        return this.is("silent", this.peek()) && this.is("{", this.peek(2));
    }

    private tryStatement(pos: SourcePosition): Statement {
        this.expect("try");
        const silent = this.accept("silent");
        const block = this.block();
        if (!this.accept("catch")) return { kind: "Try", pos, silent, block };
        let param: string | undefined;
        if (this.accept("(")) {
            param = this.identifier("a catch variable").text;
            this.expect(")");
        }
        return { kind: "Try", pos, silent, block, param, handler: this.block() };
    }

    private variableDeclaration(): VariableDeclaration {
        const pos = this.current.pos;
        const constant = this.next().text === "const";
        const declarations: Declarator[] = [];
        do {
            const token = this.identifier("a variable name");
            const type = this.accept("is") ? this.typeReference() : undefined;
            const init = this.accept("=") ? this.expression() : undefined;
            if (constant && init === undefined)
                throw this.error(`Constant "${token.text}" needs a value`, token.pos);
            declarations.push({ name: token.text, type, init, pos: token.pos });
        } while (this.accept(","));
        return { kind: "VariableDeclaration", pos, constant, declarations };
    }

    private forStatement(pos: SourcePosition): Statement {
        this.expect("(");
        if (this.isForIn()) return this.forInRest(pos);
        let init: VariableDeclaration | ExpressionStatement | undefined;
        if (this.is("var") || this.is("const")) {
            init = this.variableDeclaration();
        } else if (!this.is(";")) {
            const expression = this.expression();
            init = { kind: "ExpressionStatement", pos: expression.pos, expression };
        }
        this.expect(";");
        const test = this.is(";") ? undefined : this.expression();
        this.expect(";");
        const update = this.is(")") ? undefined : this.expression();
        this.expect(")");
        return { kind: "For", pos, init, test, update, body: this.statement() };
    }

    /** Looks ahead for `[var|const] a [, b] in` without consuming anything. */
    private isForIn(): boolean {
        let offset = 0;
        if (this.is("var", this.peek(0)) || this.is("const", this.peek(0))) offset++;
        if (this.peek(offset).kind !== "identifier") return false;
        offset++;
        if (this.is(",", this.peek(offset))) {
            if (this.peek(offset + 1).kind !== "identifier") return false;
            offset += 2;
        }
        return this.is("in", this.peek(offset));
    }

    private forInRest(pos: SourcePosition): Statement {
        const declares = this.is("var") || this.is("const");
        const constant = this.is("const");
        if (declares) this.next();
        const first = this.identifier().text;
        const second = this.accept(",") ? this.identifier().text : undefined;
        this.expect("in");
        const iterable = this.expression();
        this.expect(")");
        return { kind: "ForIn", pos, declares, constant, first, second, iterable, body: this.statement() };
    }

    // ------------------------------------------------------------------ Expressions

    private expression(): Expression {
        return this.assignment();
    }

    private assignment(): Expression {
        const target = this.conditional();
        const token = this.current;
        if (token.kind === "punct" && ASSIGNMENT_OPERATORS.has(token.text)) {
            if (!isAssignable(target)) throw this.error("Invalid assignment target", token.pos);
            this.next();
            const value = this.assignment();
            return {
                kind: "Assignment",
                pos: token.pos,
                operator: token.text as AssignmentOperator,
                target,
                value,
            };
        }
        return target;
    }

    private conditional(): Expression {
        const test = this.nullish();
        if (!this.is("?")) return test;
        const pos = this.next().pos;
        const consequent = this.assignment();
        this.expect(":");
        const alternate = this.assignment();
        return { kind: "Conditional", pos, test, consequent, alternate };
    }

    private nullish(): Expression {
        let left = this.logicalOr();
        while (this.is("??")) {
            const pos = this.next().pos;
            left = { kind: "Logical", pos, operator: "??", left, right: this.logicalOr() };
        }
        return left;
    }

    private logicalOr(): Expression {
        let left = this.logicalAnd();
        while (this.is("||")) {
            const pos = this.next().pos;
            left = { kind: "Logical", pos, operator: "||", left, right: this.logicalAnd() };
        }
        return left;
    }

    private logicalAnd(): Expression {
        let left = this.equality();
        while (this.is("&&")) {
            const pos = this.next().pos;
            left = { kind: "Logical", pos, operator: "&&", left, right: this.equality() };
        }
        return left;
    }

    private equality(): Expression {
        let left = this.relational();
        while (this.is("==") || this.is("!=")) {
            const token = this.next();
            left = this.binary(token, left, this.relational());
        }
        return left;
    }

    private relational(): Expression {
        let left = this.typeTest();
        while (this.is("<") || this.is(">") || this.is("<=") || this.is(">=")) {
            const token = this.next();
            left = this.binary(token, left, this.typeTest());
        }
        return left;
    }

    private typeTest(): Expression {
        let value = this.additive();
        for (;;) {
            if (this.is("is")) {
                const pos = this.next().pos;
                value = { kind: "Is", pos, value, type: this.typeReference() };
            } else if (this.is("as")) {
                const pos = this.next().pos;
                value = { kind: "As", pos, value, type: this.typeReference() };
            } else {
                return value;
            }
        }
    }

    private additive(): Expression {
        let left = this.multiplicative();
        while (this.is("+") || this.is("-") || this.is("~")) {
            const token = this.next();
            left = this.binary(token, left, this.multiplicative());
        }
        return left;
    }

    private multiplicative(): Expression {
        let left = this.cast();
        while (this.is("*") || this.is("/") || this.is("%")) {
            const token = this.next();
            left = this.binary(token, left, this.cast());
        }
        return left;
    }

    /** `as` binds tighter than the arithmetic operators: `x as Vector * meter`. */
    private cast(): Expression {
        let value = this.unary();
        while (this.is("as")) {
            const pos = this.next().pos;
            value = { kind: "As", pos, value, type: this.typeReference() };
        }
        return value;
    }

    private unary(): Expression {
        if (this.is("-") || this.is("+") || this.is("!")) {
            const token = this.next();
            const operand = this.unary();
            // Fold literal negation so `-1` stays a number literal (map keys, bounds).
            if (token.text === "-" && operand.kind === "Number") {
                return { kind: "Number", pos: token.pos, value: -operand.value };
            }
            return { kind: "Unary", pos: token.pos, operator: token.text as "-" | "+" | "!", operand };
        }
        return this.power();
    }

    private power(): Expression {
        const base = this.postfix();
        if (!this.is("^")) return base;
        const token = this.next();
        // Right-associative, and the exponent may carry its own sign: `x ^ -2`.
        return this.binary(token, base, this.unary());
    }

    private binary(token: Token, left: Expression, right: Expression): Expression {
        return { kind: "Binary", pos: token.pos, operator: token.text as BinaryOperator, left, right };
    }

    private postfix(): Expression {
        let expression = this.primary();
        for (;;) {
            if (this.is("(")) {
                const pos = this.next().pos;
                const args: Expression[] = [];
                while (!this.is(")")) {
                    args.push(this.expression());
                    if (!this.accept(",")) break;
                }
                this.expect(")");
                expression = { kind: "Call", pos, callee: expression, args };
            } else if (this.is("->")) {
                // `a->f(b)` calls `f(a, b)`.
                const pos = this.next().pos;
                const callee = this.calleeName();
                this.expect("(");
                const args: Expression[] = [expression];
                while (!this.is(")")) {
                    args.push(this.expression());
                    if (!this.accept(",")) break;
                }
                this.expect(")");
                expression = { kind: "Call", pos, callee, args };
            } else if (this.is(".") || this.is("?.")) {
                const optional = this.next().text === "?.";
                const pos = this.current.pos;
                const token = this.next();
                if (token.kind !== "identifier" && token.kind !== "keyword") {
                    throw this.error(`Expected a member name but found ${describe(token)}`, token.pos);
                }
                expression = { kind: "Member", pos, object: expression, property: token.text, optional };
            } else if (this.is("[")) {
                const pos = this.next().pos;
                if (this.accept("]")) {
                    expression = { kind: "BoxDeref", pos, object: expression };
                } else {
                    const index = this.expression();
                    this.expect("]");
                    expression = { kind: "Index", pos, object: expression, index };
                }
            } else {
                return expression;
            }
        }
    }

    private primary(): Expression {
        const token = this.current;
        const pos = token.pos;
        switch (token.kind) {
            case "number":
                this.next();
                return { kind: "Number", pos, value: token.value ?? 0 };
            case "string":
                this.next();
                return { kind: "String", pos, value: token.text };
            case "identifier": {
                if (this.is("=>", this.peek())) return this.arrowFunction();
                this.next();
                if (this.is("::") && this.peek().kind === "identifier") {
                    this.next();
                    const name = this.next().text;
                    return { kind: "Identifier", pos, name, namespace: token.text };
                }
                return { kind: "Identifier", pos, name: token.text };
            }
            case "eof":
                throw this.error("Unexpected end of file");
            default:
                break;
        }
        if (this.accept("true")) return { kind: "Boolean", pos, value: true };
        if (this.accept("false")) return { kind: "Boolean", pos, value: false };
        if (this.accept("undefined")) return { kind: "Undefined", pos };
        if (this.is("(") && this.isArrowParameters()) return this.arrowFunction();
        if (this.accept("(")) {
            const expression = this.expression();
            this.expect(")");
            return expression;
        }
        if (this.accept("switch")) return this.switchExpression(pos);
        if (this.is("[")) return this.arrayLiteral();
        if (this.is("{")) return this.mapLiteral();
        if (this.accept("function")) {
            // A named function expression is allowed; the name is for stack traces only.
            const name = this.current.kind === "identifier" ? this.next().text : undefined;
            return this.functionRest(pos, name);
        }
        if (this.accept("new")) {
            const box = this.identifier('"box"');
            if (box.text !== "box") throw this.error(`Expected "box" after new`, box.pos);
            this.expect("(");
            const value = this.is(")") ? ({ kind: "Undefined", pos } as Expression) : this.expression();
            this.expect(")");
            return { kind: "NewBox", pos, value };
        }
        if (this.accept("@")) {
            const name = this.identifier("a built-in name").text;
            return { kind: "Builtin", pos, name };
        }
        if (this.accept("try")) {
            const silent = this.accept("silent");
            this.expect("(");
            const value = this.expression();
            this.expect(")");
            return { kind: "TryExpression", pos, silent, value };
        }
        throw this.error(`Unexpected ${describe(token)}`);
    }

    /** The function name after `->`, optionally namespaced. */
    private calleeName(): Expression {
        const token = this.identifier("a function name after ->");
        if (this.accept("::")) {
            const name = this.identifier("a function name").text;
            return { kind: "Identifier", pos: token.pos, name, namespace: token.text };
        }
        return { kind: "Identifier", pos: token.pos, name: token.text };
    }

    /** Looks past a parenthesized list for `=>` or `returns`, without consuming anything. */
    private isArrowParameters(): boolean {
        let depth = 0;
        for (let offset = 0; ; offset++) {
            const token = this.peek(offset);
            if (token.kind === "eof") return false;
            if (this.is("(", token)) depth++;
            else if (this.is(")", token)) {
                depth--;
                if (depth === 0) {
                    const after = this.peek(offset + 1);
                    return this.is("=>", after) || this.is("returns", after);
                }
            }
        }
    }

    /**
     * `x => expr`, `(a is T, b) returns R => expr`. A `{ ... }` body is a map literal when
     * it parses as one (`index => { "index" : index }`), otherwise a statement block.
     */
    private arrowFunction(): FunctionExpression {
        const pos = this.current.pos;
        let params: Parameter[];
        if (this.current.kind === "identifier") {
            const token = this.next();
            params = [{ name: token.text, pos: token.pos }];
        } else {
            params = this.parameters();
        }
        const returns = this.accept("returns") ? this.typeReference() : undefined;
        this.expect("=>");
        if (this.is("{")) {
            const start = this.index;
            try {
                const map = this.mapLiteral();
                if (!this.is(",") && !this.is(")") && !this.is(";") && !this.is("]") && !this.is("}")) {
                    throw this.error("not a map body");
                }
                return { kind: "Function", pos, params, returns, body: returnBlock(map) };
            } catch (error) {
                if (!(error instanceof FsSyntaxError)) throw error;
                this.index = start;
            }
            return { kind: "Function", pos, params, returns, body: this.block() };
        }
        return { kind: "Function", pos, params, returns, body: returnBlock(this.assignment()) };
    }

    private switchExpression(pos: SourcePosition): Expression {
        this.expect("(");
        const subject = this.expression();
        this.expect(")");
        this.expect("{");
        const cases: { key: Expression; value: Expression }[] = [];
        while (!this.is("}")) {
            const key = this.nullish();
            this.expect(":");
            cases.push({ key, value: this.assignment() });
            if (!this.accept(",")) break;
        }
        this.expect("}", '"}" to close the switch');
        return { kind: "Switch", pos, subject, cases };
    }

    private arrayLiteral(): Expression {
        const pos = this.expect("[").pos;
        const elements: Expression[] = [];
        while (!this.is("]")) {
            elements.push(this.expression());
            if (!this.accept(",")) break;
        }
        this.expect("]");
        return { kind: "Array", pos, elements };
    }

    /**
     * `{ "key" : value, ident : value, (expr) : value, Enum.VALUE : value }` — a bare
     * identifier key is its own name as a string; any other key is an expression.
     */
    private mapLiteral(): MapLiteral {
        const pos = this.expect("{").pos;
        const entries: MapEntry[] = [];
        while (!this.is("}")) {
            const token = this.current;
            let key: Expression;
            const bare =
                (token.kind === "identifier" || token.kind === "keyword") && this.is(":", this.peek());
            if (bare && (token.text === "true" || token.text === "false")) {
                this.next();
                key = { kind: "Boolean", pos: token.pos, value: token.text === "true" };
            } else if (bare) {
                this.next();
                key = { kind: "String", pos: token.pos, value: token.text };
            } else if (token.kind === "string" && this.is(":", this.peek())) {
                this.next();
                key = { kind: "String", pos: token.pos, value: token.text };
            } else {
                key = this.nullish();
            }
            this.expect(":");
            entries.push({ key, value: this.expression() });
            if (!this.accept(",")) break;
        }
        this.expect("}", '"}" to close the map');
        return { kind: "Map", pos, entries };
    }
}

function returnBlock(value: Expression): Block {
    return { kind: "Block", pos: value.pos, body: [{ kind: "Return", pos: value.pos, value }] };
}

function isAssignable(expression: Expression): boolean {
    switch (expression.kind) {
        case "Identifier":
            return expression.namespace === undefined;
        case "Member":
        case "Index":
        case "BoxDeref":
            return true;
        default:
            return false;
    }
}

function describe(token: Token): string {
    switch (token.kind) {
        case "eof":
            return "end of file";
        case "string":
            return `string "${token.text}"`;
        case "number":
            return `number ${token.text}`;
        default:
            return `"${token.text}"`;
    }
}
