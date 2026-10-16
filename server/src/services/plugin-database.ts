import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  pluginDatabaseNamespaces,
  pluginMigrations,
  plugins,
} from "@paperclipai/db";
import type {
  PaperclipPluginManifestV1,
  PluginDatabaseCoreReadTable,
  PluginMigrationRecord,
} from "@paperclipai/shared";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_POSTGRES_IDENTIFIER_LENGTH = 63;
const VALUE_TABLE_FUNCTIONS = new Set([
  "jsonb_array_elements", "jsonb_array_elements_text", "jsonb_to_recordset", "unnest",
]);
const SAFE_SQL_FUNCTIONS = new Set([
  "array_to_string", "avg", "btrim", "cardinality", "chr", "clock_timestamp", "count",
  "gen_random_uuid", "jsonb_agg", "jsonb_array_elements", "jsonb_array_elements_text", "jsonb_array_length",
  "jsonb_build_object", "jsonb_to_recordset", "jsonb_typeof", "length", "lower", "max", "now", "replace",
  "split_part", "to_jsonb", "unnest",
]);
const SAFE_SQL_TYPES = new Set([
  "bigint", "bigserial", "bit", "bool", "boolean", "bpchar", "bytea", "char", "character", "cidr",
  "date", "decimal", "double", "float4", "float8", "inet", "int", "int2", "int4", "int8", "integer",
  "interval", "json", "jsonb", "macaddr", "macaddr8", "money", "name", "numeric", "oid", "pg_lsn",
  "pg_snapshot", "real", "regclass", "regconfig", "regnamespace", "regoper", "regoperator", "regproc",
  "regprocedure", "regrole", "regtype", "serial", "serial2", "serial4", "serial8", "smallint", "smallserial", "text",
  "time", "timestamp", "timetz", "timestamptz", "tsquery", "tsvector", "txid_snapshot", "uuid", "varbit",
  "varchar", "xml",
]);

type SqlRef = { schema: string; table: string; keyword: string };

type SqlToken = { value: string; identifier: boolean; quoted?: boolean };

type TypedLiteralToken = SqlToken & {
  start: number;
  end: number;
  string?: boolean;
  raw?: string;
};

export type PluginDatabaseRuntimeResult<T = Record<string, unknown>> = {
  rows?: T[];
  rowCount?: number;
};

export function derivePluginDatabaseNamespace(
  pluginKey: string,
  namespaceSlug?: string,
): string {
  const hash = createHash("sha256").update(pluginKey).digest("hex").slice(0, 10);
  const slug = (namespaceSlug ?? pluginKey)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 36) || "plugin";
  const namespace = `plugin_${slug}_${hash}`;
  return namespace.slice(0, MAX_POSTGRES_IDENTIFIER_LENGTH);
}

function assertIdentifier(value: string, label = "identifier"): string {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`Unsafe SQL ${label}: ${value}`);
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${assertIdentifier(value).replaceAll("\"", "\"\"")}"`;
}

type SqlSegment = { kind: "code" | "string" | "identifier" | "comment"; raw: string };

function isSqlIdentifierPart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(char);
}

function scanSql(input: string): SqlSegment[] {
  const segments: SqlSegment[] = [];
  let codeStart = 0;
  let cursor = 0;
  while (cursor < input.length) {
    const start = cursor;
    const char = input[cursor]!;
    const next = input[cursor + 1];
    let kind: SqlSegment["kind"] | undefined;
    if (char === "-" && next === "-") {
      kind = "comment";
      cursor += 2;
      while (cursor < input.length && !["\n", "\r"].includes(input[cursor]!)) cursor += 1;
    } else if (char === "/" && next === "*") {
      kind = "comment";
      cursor += 2;
      let depth = 1;
      while (cursor < input.length && depth > 0) {
        if (input[cursor] === "/" && input[cursor + 1] === "*") {
          depth += 1;
          cursor += 2;
        } else if (input[cursor] === "*" && input[cursor + 1] === "/") {
          depth -= 1;
          cursor += 2;
        } else cursor += 1;
      }
      if (depth > 0) throw new Error("Unterminated SQL block comment");
    } else if (char === "'" || char === '"') {
      if (char === '"' && input[cursor - 1] === "&" && /[uU]/.test(input[cursor - 2] ?? "")
        && !isSqlIdentifierPart(input[cursor - 3])) {
        throw new Error("Plugin SQL does not support Unicode escape quoted identifiers");
      }
      kind = char === "'" ? "string" : "identifier";
      const escaped = char === "'" && /[eE]/.test(input[cursor - 1] ?? "")
        && !isSqlIdentifierPart(input[cursor - 2]);
      cursor += 1;
      let closed = false;
      while (cursor < input.length) {
        if (escaped && input[cursor] === "\\") cursor += 2;
        else if (input[cursor] === char) {
          cursor += 1;
          if (input[cursor] === char) cursor += 1;
          else {
            closed = true;
            break;
          }
        } else cursor += 1;
      }
      if (!closed) throw new Error("Unterminated SQL quote");
    } else if (char === "$" && !isSqlIdentifierPart(input[cursor - 1])) {
      const delimiter = /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/.exec(input.slice(cursor))?.[0];
      if (delimiter) {
        kind = "string";
        const end = input.indexOf(delimiter, cursor + delimiter.length);
        if (end < 0) throw new Error("Unterminated SQL dollar quote");
        cursor = end + delimiter.length;
      }
    }
    if (!kind) {
      cursor += 1;
      continue;
    }
    if (start > codeStart) segments.push({ kind: "code", raw: input.slice(codeStart, start) });
    segments.push({ kind, raw: input.slice(start, cursor) });
    codeStart = cursor;
  }
  if (codeStart < input.length) segments.push({ kind: "code", raw: input.slice(codeStart) });
  return segments;
}

function splitSqlStatements(input: string): string[] {
  const statements: string[] = [];
  let current = "";
  const finish = () => {
    if (stripSqlForKeywordScan(current).trim()) statements.push(current.trim());
    current = "";
  };
  for (const segment of scanSql(input)) {
    if (segment.kind !== "code") {
      current += segment.raw;
      continue;
    }
    const parts = segment.raw.split(";");
    current += parts[0];
    for (const part of parts.slice(1)) {
      finish();
      current = part;
    }
  }
  finish();
  return statements;
}

function stripSqlForKeywordScan(input: string, preserveIdentifiers = false): string {
  return scanSql(input).map((segment) => {
    if (segment.kind === "comment") return " ";
    if (segment.kind === "string") return "''";
    if (segment.kind === "identifier" && !preserveIdentifiers) return '""';
    return segment.raw;
  }).join("");
}

function normaliseSql(input: string): string {
  return stripSqlForKeywordScan(input).replace(/\s+/g, " ").trim().toLowerCase();
}

function tokenizeSqlRelations(statement: string): SqlToken[] {
  const scannable = stripSqlForKeywordScan(statement, true);
  return [...scannable.matchAll(/"(?:[^"]|"")*"|[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*|[^\s]/g)].map((match) => {
    const raw = match[0];
    if (raw.startsWith('"')) {
      return { value: raw.slice(1, -1).replaceAll('""', '"'), identifier: true, quoted: true };
    }
    const identifier = /^[A-Za-z_\u0080-\uFFFF]/.test(raw);
    // PostgreSQL UTF-8 folds ASCII letters only. Unicode lowercasing could
    // confuse a persistent relation such as Kelvin-sign with an ASCII CTE.
    return { value: identifier ? raw.replace(/[A-Z]/g, (char) => char.toLowerCase()) : raw, identifier };
  });
}

function tokenizeSqlTypedLiterals(statement: string): TypedLiteralToken[] {
  const tokens: TypedLiteralToken[] = [];
  let offset = 0;
  for (const segment of scanSql(statement)) {
    if (segment.kind === "string") {
      tokens.push({
        value: "",
        identifier: false,
        string: true,
        raw: segment.raw,
        start: offset,
        end: offset + segment.raw.length,
      });
    } else if (segment.kind === "identifier") {
      tokens.push({
        value: segment.raw.slice(1, -1).replaceAll('""', '"'),
        identifier: true,
        quoted: true,
        start: offset,
        end: offset + segment.raw.length,
      });
    } else if (segment.kind === "code") {
      for (const match of segment.raw.matchAll(/[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*|[^\s]/g)) {
        const raw = match[0];
        const identifier = /^[A-Za-z_\u0080-\uFFFF]/.test(raw);
        const start = offset + match.index!;
        tokens.push({
          value: identifier ? raw.replace(/[A-Z]/g, (char) => char.toLowerCase()) : raw,
          identifier,
          start,
          end: start + raw.length,
        });
      }
    }
    offset += segment.raw.length;
  }
  return tokens;
}

function isSqlSymbol(token: SqlToken | undefined, value: string): boolean {
  return token?.value === value && !token.identifier;
}

export function validatePluginSqlFunctions(statement: string): void {
  const tokens = tokenizeSqlRelations(statement);
  const syntax = new Set([
    "all", "and", "any", "array", "as", "by", "case", "cast", "check", "coalesce", "conflict", "default",
    "exists", "extract", "filter", "from", "greatest", "having", "in", "join", "key", "least", "not",
    "on", "only", "or", "over", "overlay", "returning", "select", "set", "substring", "trim", "unique", "using",
    "values", "when", "where",
  ]);
  const closes = new Map<number, number>();
  const parents = new Map<number, number>();
  const opens: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (opens.length) parents.set(index, opens.at(-1)!);
    if (isSqlSymbol(tokens[index], "(")) opens.push(index);
    if (isSqlSymbol(tokens[index], ")")) {
      const open = opens.pop();
      if (open !== undefined) closes.set(open, index);
    }
  }
  const keywordAt = (index: number, keyword: string) => tokens[index]?.value === keyword && !tokens[index]?.quoted;
  // PostgreSQL can interpret field selection as a one-argument function
  // call. Parenthesized/scalar indirection is unsupported; plain relation
  // column references remain valid.
  for (let index = 1; index < tokens.length - 1; index += 1) {
    if (isSqlSymbol(tokens[index], ".") && !tokens[index - 1]?.identifier && tokens[index + 1]?.identifier) {
      let numberStart = index - 1;
      while (/^\d$/.test(tokens[numberStart - 1]?.value ?? "")) numberStart -= 1;
      if (/^\d$/.test(tokens[index - 1]!.value) && !isSqlSymbol(tokens[numberStart - 1], "$")
        && !tokens[index + 1]?.quoted && /^e\d*$/.test(tokens[index + 1]!.value)) continue;
      throw new Error("Plugin SQL does not support expression field notation");
    }
  }
  const scalarAliases: Array<{ alias: string; columns: Set<string> | null; scope: number }> = [];
  const aliasDeclarations = new Set<number>();
  const aliasColumnLists = new Set<number>();
  const typedAliasColumnLists = new Set<number>();
  const queryScope = (index: number): number => {
    let open = parents.get(index);
    while (open !== undefined) {
      const currentOpen = open;
      if (["select", "with", "values", "table"].some((word) => keywordAt(currentOpen + 1, word))) return open;
      open = parents.get(open);
    }
    return -1;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    if (!VALUE_TABLE_FUNCTIONS.has(tokens[index]!.value) || !isSqlSymbol(tokens[index + 1], "(")) continue;
    const start = isSqlSymbol(tokens[index - 1], ".") ? index - 2 : index;
    let introducer = start - 1;
    while (isSqlSymbol(tokens[introducer], "(")) introducer -= 1;
    if (!["from", "join", "lateral"].some((word) => keywordAt(introducer, word))
      && !isSqlSymbol(tokens[introducer], ",")) continue;
    const close = closes.get(index + 1);
    if (close === undefined) continue;
    let cursor = close + 1;
    for (let wrappers = start - introducer - 1; wrappers > 0 && isSqlSymbol(tokens[cursor], ")"); wrappers -= 1) cursor += 1;
    const columns = new Set([tokens[index]!.value === "unnest" ? "unnest" : "value"]);
    if (keywordAt(cursor, "with") && keywordAt(cursor + 1, "ordinality")) {
      columns.add("ordinality");
      cursor += 2;
    }
    if (keywordAt(cursor, "as")) cursor += 1;
    let alias = tokens[index]!.value;
    if (tokens[cursor]?.identifier && (tokens[cursor]?.quoted
      || !["where", "join", "left", "right", "full", "inner", "cross", "on", "group", "order", "limit", "union", "returning"].includes(tokens[cursor]!.value))) {
      aliasDeclarations.add(cursor);
      alias = tokens[cursor++]!.value;
      columns.add(alias);
    }
    if (isSqlSymbol(tokens[cursor], "(")) {
      aliasColumnLists.add(cursor);
      if (tokens[index]!.value === "jsonb_to_recordset") typedAliasColumnLists.add(cursor);
      columns.clear();
      const end = closes.get(cursor) ?? cursor;
      let column = true;
      for (cursor += 1; cursor < end; cursor += 1) {
        if (column && tokens[cursor]?.identifier) columns.add(tokens[cursor]!.value);
        column = isSqlSymbol(tokens[cursor], ",");
        if (isSqlSymbol(tokens[cursor], "(")) cursor = closes.get(cursor) ?? end;
      }
    }
    scalarAliases.push({ alias, columns, scope: queryScope(start) });
  }
  // A local ordinary relation can shadow a scalar alias in an outer query.
  for (const ref of extractRuntimeRelationRefs(tokens)) {
    if (!["from", "join", "using"].includes(ref.keyword)) continue;
    let cursor = ref.tokenIndex + (ref.schema ? 3 : 1);
    if (keywordAt(cursor, "as")) cursor += 1;
    const alias = tokens[cursor]?.identifier && (tokens[cursor]?.quoted
      || !["where", "join", "left", "right", "full", "inner", "cross", "on", "group", "order", "limit", "union", "returning"].includes(tokens[cursor]!.value))
      ? tokens[cursor]!.value : ref.table;
    scalarAliases.push({ alias, columns: null, scope: queryScope(ref.tokenIndex) });
  }
  for (const [open, close] of closes) {
    if (!["select", "with", "values", "table"].some((word) => keywordAt(open + 1, word))) continue;
    const alias = keywordAt(close + 1, "as") ? close + 2 : close + 1;
    if (tokens[alias]?.identifier) scalarAliases.push({ alias: tokens[alias]!.value, columns: null, scope: queryScope(open) });
  }
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (!tokens[index]?.identifier || !isSqlSymbol(tokens[index + 1], ".") || !tokens[index + 2]?.identifier) continue;
    for (let scope = queryScope(index); ; scope = queryScope(scope)) {
      const binding = scalarAliases.find((alias) => alias.alias === tokens[index]!.value && alias.scope === scope);
      if (binding) {
        if (binding.columns && !binding.columns.has(tokens[index + 2]!.value)) {
          throw new Error("Plugin SQL does not support scalar table-function field notation");
        }
        break;
      }
      if (scope === -1) break;
    }
  }
  const typePositions = new Set<number>();
  const declaredTypePositions = new Set<number>();
  const skipName = (start: number) => {
    let cursor = start + 1;
    while (isSqlSymbol(tokens[cursor], ".") && tokens[cursor + 1]?.identifier) cursor += 2;
    return cursor;
  };
  const markColumns = (open: number, declarations = false) => {
    const end = closes.get(open);
    if (end === undefined) return;
    let cursor = open + 1;
    while (cursor < end) {
      if (tokens[cursor]?.identifier && (tokens[cursor]?.quoted
        || !["constraint", "primary", "foreign", "unique", "check", "exclude", "like"].includes(tokens[cursor]!.value))) {
        typePositions.add(cursor + 1);
        if (declarations) declaredTypePositions.add(cursor + 1);
      }
      while (cursor < end && !isSqlSymbol(tokens[cursor], ",")) {
        cursor = isSqlSymbol(tokens[cursor], "(") ? (closes.get(cursor) ?? end) + 1 : cursor + 1;
      }
      cursor += 1;
    }
  };
  for (const open of aliasColumnLists) markColumns(open, typedAliasColumnLists.has(open));
  if (keywordAt(0, "create") && keywordAt(1, "table")) {
    let cursor = keywordAt(2, "if") ? (keywordAt(3, "not") ? 5 : 4) : 2;
    cursor = skipName(cursor);
    if (isSqlSymbol(tokens[cursor], "(")) markColumns(cursor, true);
  }
  if (keywordAt(0, "alter") && keywordAt(1, "table")) {
    for (let index = 2; index < tokens.length; index += 1) {
      if (parents.has(index)) continue;
      if (keywordAt(index, "add")) {
        let column = index + (keywordAt(index + 1, "column") ? 2 : 1);
        if (keywordAt(column, "if") && keywordAt(column + 1, "not") && keywordAt(column + 2, "exists")) column += 3;
        if (tokens[column]?.identifier && (tokens[column]?.quoted
          || !["constraint", "primary", "foreign", "unique", "check", "exclude", "generated"].includes(tokens[column]!.value))) {
          typePositions.add(column + 1);
          declaredTypePositions.add(column + 1);
        }
      }
      if (keywordAt(index, "alter") && keywordAt(index + 1, "column")) {
        let type = index + 3;
        if (keywordAt(type, "set") && keywordAt(type + 1, "data")) type += 2;
        if (keywordAt(type, "type")) {
          typePositions.add(type + 1);
          declaredTypePositions.add(type + 1);
        }
      }
    }
  }
  // Recordset aliases can declare typed output columns too.
  for (let index = 0; index < tokens.length; index += 1) {
    if (keywordAt(index, "as")) {
      const open = isSqlSymbol(tokens[index + 1], "(") ? index + 1 : index + 2;
      if (isSqlSymbol(tokens[open], "(")) markColumns(open);
    }
  }
  const isCastTypePosition = (start: number) => {
    const open = parents.get(start);
    return keywordAt(start - 1, "as") && open !== undefined && keywordAt(open - 1, "cast")
      && !isSqlSymbol(tokens[open - 2], ".");
  };
  const assertSafeTypeAt = (start: number) => {
    let typeIndex = start;
    let schema: SqlToken | undefined;
    if (tokens[start]?.identifier && isSqlSymbol(tokens[start + 1], ".") && tokens[start + 2]?.identifier) {
      schema = tokens[start];
      typeIndex = start + 2;
    }
    const type = tokens[typeIndex];
    if (!type?.identifier || (schema && (schema.value !== "pg_catalog" || isSqlSymbol(tokens[typeIndex + 1], ".")))) {
      throw new Error("Plugin SQL function or type target is not allowed; type targets must be built-in PostgreSQL types");
    }
    if (!SAFE_SQL_TYPES.has(type.value)) {
      throw new Error(`Plugin SQL function or type "${schema ? `${schema.value}.` : ""}${type.value}" is not allowed`);
    }
    if (type.quoted && type.value !== type.value.toLowerCase()) {
      throw new Error(`Plugin SQL function or type "${type.value}" is not allowed`);
    }
  };

  const literalTokens = tokenizeSqlTypedLiterals(statement);
  const literalOpens: number[] = [];
  const literalOpening = new Map<number, number>();
  for (let index = 0; index < literalTokens.length; index += 1) {
    if (isSqlSymbol(literalTokens[index], "(")) literalOpens.push(index);
    if (isSqlSymbol(literalTokens[index], ")")) {
      const open = literalOpens.pop();
      if (open !== undefined) literalOpening.set(index, open);
    }
  }
  const literalIntroducers = new Set([
    "all", "and", "any", "as", "both", "case", "default", "distinct", "else", "from", "having", "in", "is",
    "leading", "limit", "not", "offset", "on", "or", "placing", "returning", "select", "symmetric", "then", "to",
    "trailing", "using", "values", "when", "where",
  ]);
  const isLiteralIntroducer = (index: number): boolean => {
    const word = literalTokens[index]?.value ?? "";
    if (literalIntroducers.has(word) && !literalTokens[index]?.quoted) return true;
    const previousWord = literalTokens[index - 1]?.quoted ? "" : literalTokens[index - 1]?.value;
    if (word === "by" && ["group", "order", "partition"].includes(previousWord ?? "")) return true;
    if (word === "zone" && previousWord === "time" && literalTokens[index - 2]?.value === "at") return true;
    if (["between", "ilike", "like"].includes(word)) {
      const left = literalTokens[index - 1];
      return Boolean(left && (
        left.string || [")", "]"].includes(left.value)
        || (left.identifier && !literalIntroducers.has(left.value))
      ));
    }
    if (word === "escape") {
      return literalTokens.slice(Math.max(0, index - 6), index)
        .some((token) => !token.quoted && ["ilike", "like", "similar"].includes(token.value));
    }
    if (["first", "next"].includes(word) && previousWord === "fetch") return true;
    if (word === "uescape") return Boolean(literalTokens[index - 1]?.string);
    return false;
  };
  const lexicalStringPrefix = (stringIndex: number): boolean => {
    const string = literalTokens[stringIndex]!;
    const previous = literalTokens[stringIndex - 1];
    if (!previous || previous.end !== string.start || previous.quoted) return false;
    if (previous.identifier && ["b", "e", "n", "x"].includes(previous.value)) return true;
    return previous.value === "&" && literalTokens[stringIndex - 2]?.value === "u"
      && literalTokens[stringIndex - 2]?.end === previous.start;
  };
  const assertSafeTypedLiterals = () => {
    for (let stringIndex = 0; stringIndex < literalTokens.length; stringIndex += 1) {
      if (!literalTokens[stringIndex]?.string || lexicalStringPrefix(stringIndex)) continue;
      let end = stringIndex - 1;
      if (end < 0) continue;

      // PostgreSQL permits array suffixes and the datetime zone qualifier
      // between a type name and its quoted literal.
      while (isSqlSymbol(literalTokens[end], "]") && isSqlSymbol(literalTokens[end - 1], "[")) end -= 2;
      if (literalTokens[end]?.value === "zone" && literalTokens[end - 1]?.value === "time"
        && ["with", "without"].includes(literalTokens[end - 2]?.value ?? "")) end -= 3;

      let modifier = false;
      if (isSqlSymbol(literalTokens[end], ")")) {
        const open = literalOpening.get(end);
        if (open === undefined) continue;
        const modifiers = literalTokens.slice(open + 1, end).map((token) => token.value).join("");
        if (!/^[+-]?\d+(?:,[+-]?\d+)?$/.test(modifiers)) continue;
        modifier = true;
        end = open - 1;
      }

      let canonicalType = literalTokens[end]?.value;
      let start = end;
      if (!literalTokens[end]?.quoted && literalTokens[end]?.value === "varying"
        && !literalTokens[end - 1]?.quoted
        && ["bit", "char", "character"].includes(literalTokens[end - 1]?.value ?? "")) {
        start -= 1;
        canonicalType = literalTokens[start]!.value === "bit" ? "varbit" : "varchar";
      } else if (!literalTokens[end]?.quoted && literalTokens[end]?.value === "precision"
        && !literalTokens[end - 1]?.quoted && literalTokens[end - 1]?.value === "double") {
        start -= 1;
        canonicalType = "double";
      }
      if (!literalTokens[start]?.identifier) continue;

      while (isSqlSymbol(literalTokens[start - 1], ".") && literalTokens[start - 2]?.identifier) start -= 2;
      const nameTokens = literalTokens.slice(start, end + 1);
      const dots = nameTokens.filter((token) => token.value === "." && !token.identifier).length;
      const qualified = dots > 0;
      const suspicious = qualified || modifier || literalTokens[start]?.quoted
        || SAFE_SQL_TYPES.has(canonicalType ?? "") || !isLiteralIntroducer(start);
      if (!suspicious) continue;

      const base = literalTokens[end]!;
      const schema = dots === 1 ? literalTokens[start] : undefined;
      if (dots > 1 || (dots === 1 && (!schema?.identifier || schema.value !== "pg_catalog"))) {
        const name = nameTokens.map((token) => token.quoted ? `"${token.value}"` : token.value).join("");
        throw new Error(`Plugin SQL function or type "${name}" is not allowed`);
      }
      if (!SAFE_SQL_TYPES.has(canonicalType ?? "") || (base.quoted && base.value !== base.value.toLowerCase())) {
        const name = nameTokens.map((token) => token.quoted ? `"${token.value}"` : token.value).join("");
        throw new Error(`Plugin SQL function or type "${name}" is not allowed`);
      }
    }
  };
  assertSafeTypedLiterals();
  for (const position of declaredTypePositions) assertSafeTypeAt(position);
  for (let index = 0; index < tokens.length; index += 1) {
    if (isCastTypePosition(index)) assertSafeTypeAt(index);
    if (isSqlSymbol(tokens[index], ":") && isSqlSymbol(tokens[index + 1], ":")) {
      assertSafeTypeAt(index + 2);
    }
  }
  const isNativeTypeModifier = (index: number) => {
    let start = index;
    let name = tokens[index]!.value;
    if (!tokens[index]?.quoted && name === "varying" && ["character", "char", "bit"].some((word) => keywordAt(index - 1, word))) {
      start -= 1;
      name = tokens[start]!.value === "bit" ? "varbit" : "varchar";
    } else if (keywordAt(index, "second")) {
      if (keywordAt(index - 1, "interval")) start -= 1;
      else if (keywordAt(index - 1, "to") && ["day", "hour", "minute"].some((word) => keywordAt(index - 2, word))
        && keywordAt(index - 3, "interval")) start -= 3;
      else return false;
      name = "interval";
    }
    if (!["numeric", "decimal", "varchar", "character", "char", "bpchar", "bit", "varbit",
      "time", "timetz", "timestamp", "timestamptz", "interval"].includes(name)) return false;
    if (isSqlSymbol(tokens[start - 1], ".")) {
      if (tokens[start - 2]?.value !== "pg_catalog" || isSqlSymbol(tokens[start - 3], ".")) return false;
      start -= 2;
    }
    const close = closes.get(index + 1);
    if (close === undefined) return false;
    const modifiers = tokens.slice(index + 2, close).map((token) => token.value).join("");
    if (!(name === "numeric" || name === "decimal" ? /^[+-]?\d+(?:,[+-]?\d+)?$/ : /^\d+$/).test(modifiers)) return false;
    const literalAfterModifier = isSqlSymbol(tokens[close + 1], "'") && isSqlSymbol(tokens[close + 2], "'");
    const datetimeLiteralAfterZone = ["time", "timestamp", "timetz", "timestamptz"].includes(name)
      && ["with", "without"].some((word) => keywordAt(close + 1, word))
      && keywordAt(close + 2, "time") && keywordAt(close + 3, "zone")
      && isSqlSymbol(tokens[close + 4], "'") && isSqlSymbol(tokens[close + 5], "'");
    return typePositions.has(start) || isCastTypePosition(start)
      || (isSqlSymbol(tokens[start - 1], ":") && isSqlSymbol(tokens[start - 2], ":"))
      || literalAfterModifier || datetimeLiteralAfterZone;
  };
  const createIndex = /^create\s+(?:unique\s+)?(?:concurrently\s+)?index\b/.test(normaliseSql(statement));
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.identifier || !isSqlSymbol(tokens[index + 1], "(")) continue;
    let start = index;
    while (isSqlSymbol(tokens[start - 1], ".") && tokens[start - 2]?.identifier) start -= 2;
    const previous = tokens[start - 1];
    if (aliasDeclarations.has(index)) continue;
    if (isNativeTypeModifier(index)) continue;
    // Relation column lists and AS aliases are declarations, not calls. CTE
    // columns are identified by their following AS, not a global name list.
    if (previous && !previous.quoted && (["into", "table", "references"].includes(previous.value)
      || (previous.value === "as" && !isCastTypePosition(start)))) continue;
    if (previous?.value === "exists" && !previous.quoted) {
      let declaration = start - 2;
      if (tokens[declaration]?.value === "not" && !tokens[declaration]?.quoted) declaration -= 1;
      if (tokens[declaration]?.value === "if" && !tokens[declaration]?.quoted
        && tokens[declaration - 1]?.value === "table" && !tokens[declaration - 1]?.quoted) continue;
    }
    if (createIndex && previous?.value === "on" && !previous.quoted) continue;
    if (!token.quoted && token.value === "materialized" && previous && !previous.quoted
      && (previous.value === "as" || (previous.value === "not" && tokens[index - 2]?.value === "as" && !tokens[index - 2]?.quoted))) continue;
    if (!token.quoted && ["list", "range", "hash"].includes(token.value) && previous?.value === "by"
      && !previous.quoted && tokens[index - 2]?.value === "partition" && !tokens[index - 2]?.quoted) continue;
    const close = closes.get(index + 1);
    if (start === index && close !== undefined && tokens[close + 1]?.value === "as" && !tokens[close + 1]?.quoted) {
      let body = close + 2;
      if (tokens[body]?.value === "not" && !tokens[body]?.quoted) body += 1;
      if (tokens[body]?.value === "materialized" && !tokens[body]?.quoted) body += 1;
      if (isSqlSymbol(tokens[body], "(")) continue;
    }
    if (start === index && !token.quoted && syntax.has(token.value)) continue;
    const schema = start < index ? tokens.slice(start, index).map((part) => part.value).join("") : null;
    if (SAFE_SQL_FUNCTIONS.has(token.value) && (schema === null || schema === "pg_catalog.")) continue;
    throw new Error(`Plugin SQL function "${schema ?? ""}${token.value}" is not allowed`);
  }
}

function runtimeCteScopes(tokens: readonly SqlToken[]): Array<{ name: string; start: number; end: number }> {
  const scopes: Array<{ name: string; start: number; end: number }> = [];
  const closingParens = new Map<number, number>();
  const openParens: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (isSqlSymbol(tokens[index], "(")) openParens.push(index);
    if (isSqlSymbol(tokens[index], ")")) {
      const opening = openParens.pop();
      if (opening !== undefined) closingParens.set(opening, index);
    }
  }

  const enclosingEnds: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (isSqlSymbol(token, ")")) enclosingEnds.pop();
    if (isSqlSymbol(token, "(")) enclosingEnds.push(closingParens.get(index) ?? tokens.length);
    if (token.value !== "with" || token.quoted) continue;

    const end = enclosingEnds.at(-1) ?? tokens.length;
    const recursive = tokens[index + 1]?.value === "recursive" && !tokens[index + 1]?.quoted;
    let cursor = index + (recursive ? 2 : 1);
    while (tokens[cursor]?.identifier) {
      const name = tokens[cursor]!.value;
      cursor += 1;
      // Optional CTE column names do not change its visibility.
      if (isSqlSymbol(tokens[cursor], "(")) cursor = (closingParens.get(cursor) ?? tokens.length) + 1;
      if (tokens[cursor]?.value !== "as" || tokens[cursor]?.quoted) break;
      cursor += 1;
      if (tokens[cursor]?.value === "not" && !tokens[cursor]?.quoted) cursor += 1;
      if (tokens[cursor]?.value === "materialized" && !tokens[cursor]?.quoted) cursor += 1;
      if (!isSqlSymbol(tokens[cursor], "(")) break;
      const bodyEnd = closingParens.get(cursor);
      if (bodyEnd === undefined) break;
      // Non-recursive names become visible only after their own body. A
      // recursive WITH makes all names visible throughout its WITH group.
      scopes.push({ name, start: recursive ? index : bodyEnd + 1, end });
      cursor = bodyEnd + 1;
      if (!isSqlSymbol(tokens[cursor], ",")) break;
      cursor += 1;
    }
  }
  return scopes;
}

function extractRuntimeRelationRefs(tokens: readonly SqlToken[], includeUsing = true): Array<SqlRef & { tokenIndex: number }> {
  const refs: Array<SqlRef & { tokenIndex: number }> = [];
  // These built-ins expand supplied values rather than read persistent relations.
  // Require call syntax so a same-named, unqualified table is still rejected.
  const clauseEnds = new Set([
    "where", "group", "having", "order", "limit", "offset", "fetch", "for",
    "returning", "set", "values", "union", "intersect", "except", "window",
  ]);

  const readRef = (keyword: string, start: number): number => {
    let cursor = start;
    if (["table", "table_target", "new_table"].includes(keyword) && tokens[cursor]?.value === "if" && !tokens[cursor]?.quoted) {
      cursor += 1;
      if (tokens[cursor]?.value === "not" && !tokens[cursor]?.quoted) cursor += 1;
      if (tokens[cursor]?.value === "exists" && !tokens[cursor]?.quoted) cursor += 1;
    }
    if (!tokens[cursor]?.quoted && ["only", "lateral"].includes(tokens[cursor]?.value ?? "")) cursor += 1;
    if (isSqlSymbol(tokens[cursor], "(")) {
      // A derived SELECT is scanned by the outer token walk. Parentheses around
      // a relation (including ONLY (...)) still need to validate that relation.
      if (["select", "with", "values", "table"].includes(tokens[cursor + 1]?.value ?? "") && !tokens[cursor + 1]?.quoted) return cursor;
      readRef(keyword, cursor + 1);
      return cursor;
    }
    const first = tokens[cursor];
    if (!first?.identifier) return cursor;
    if (isSqlSymbol(tokens[cursor + 1], ".") && tokens[cursor + 2]?.identifier) {
      if (!["table", "table_target", "new_table", "references"].includes(keyword) && first.value === "pg_catalog" && VALUE_TABLE_FUNCTIONS.has(tokens[cursor + 2]!.value)
        && isSqlSymbol(tokens[cursor + 3], "(")) return cursor + 3;
      refs.push({ keyword, schema: first.value, table: tokens[cursor + 2]!.value, tokenIndex: cursor });
      return cursor + 3;
    }
    if (!["table", "table_target", "new_table", "references"].includes(keyword) && isSqlSymbol(tokens[cursor + 1], "(") && VALUE_TABLE_FUNCTIONS.has(first.value)) return cursor + 1;
    refs.push({ keyword, schema: "", table: first.value, tokenIndex: cursor });
    return cursor + 1;
  };

  const isExpressionFrom = (index: number): boolean => {
    // IS [NOT] DISTINCT FROM compares expressions; FROM does not start a
    // relation list here, even when its right operand is a cast parameter.
    if (tokens[index - 1]?.value === "distinct" && !tokens[index - 1]?.quoted) {
      const isIndex = tokens[index - 2]?.value === "not" && !tokens[index - 2]?.quoted ? index - 3 : index - 2;
      if (tokens[isIndex]?.value === "is" && !tokens[isIndex]?.quoted) return true;
    }
    let depth = 0;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (isSqlSymbol(tokens[cursor], ")")) depth += 1;
      else if (isSqlSymbol(tokens[cursor], "(")) {
        if (depth > 0) depth -= 1;
        else {
          return !tokens[cursor - 1]?.quoted && ["extract", "overlay", "substring", "trim"].includes(tokens[cursor - 1]?.value ?? "");
        }
      }
    }
    return false;
  };

  const isJoinColumnList = (index: number): boolean => {
    if (!isSqlSymbol(tokens[index + 1], "(")) return false;
    let cursor = index + 2;
    while (tokens[cursor]?.identifier) {
      cursor += 1;
      if (isSqlSymbol(tokens[cursor], ")")) return true;
      if (!isSqlSymbol(tokens[cursor], ",")) return false;
      cursor += 1;
    }
    return false;
  };

  const startsRelation = (index: number): boolean => {
    const token = tokens[index]!;
    return !token.quoted && ["from", "join", "using", "table", "references"].includes(token.value)
      && !(token.value === "from" && isExpressionFrom(index))
      && !(token.value === "using" && !includeUsing)
      && !(token.value === "using" && isJoinColumnList(index));
  };

  for (let i = 0; i < tokens.length; i += 1) {
    if (!startsRelation(i)) continue;
    const previous = tokens[i - 1];
    const keyword = tokens[i]!.value === "table" && previous && !previous.quoted
      && ["create", "alter", "drop", "truncate", "on", "temp", "temporary", "unlogged"].includes(previous.value)
      ? (["create", "temp", "temporary", "unlogged"].includes(previous.value) ? "new_table" : "table_target") : tokens[i]!.value;

    let cursor = readRef(keyword, i + 1);
    if (["table", "table_target", "new_table", "references"].includes(keyword)) continue;
    let depth = 0;
    while (cursor < tokens.length) {
      const value = tokens[cursor]!.value;
      if (isSqlSymbol(tokens[cursor], "(")) depth += 1;
      else if (isSqlSymbol(tokens[cursor], ")")) {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && !tokens[cursor]!.quoted && clauseEnds.has(value)) break;
      else if (depth === 0 && startsRelation(cursor)) break;
      else if (depth === 0 && isSqlSymbol(tokens[cursor], ",")) {
        cursor = readRef(keyword, cursor + 1);
        continue;
      }
      cursor += 1;
    }
  }
  return refs;
}

function assertRuntimeRelationsQualified(
  statement: string,
  namespace: string,
  allowedCoreReadTables?: ReadonlySet<string>,
  includeUsing = true,
): void {
  const tokens = tokenizeSqlRelations(statement);
  const cteScopes = runtimeCteScopes(tokens);
  for (const ref of extractRuntimeRelationRefs(tokens, includeUsing)) {
    if (!ref.schema) {
      if (cteScopes.some((scope) => scope.name === ref.table && ref.tokenIndex >= scope.start && ref.tokenIndex < scope.end)) continue;
      throw new Error(`Plugin runtime SQL relation "${ref.table}" must use a fully qualified schema name`);
    }
    if (ref.schema === namespace) continue;
    if (allowedCoreReadTables && ref.schema === "public") {
      assertAllowedPublicRead(ref, allowedCoreReadTables);
      continue;
    }
    throw new Error(`Plugin runtime SQL cannot reference schema "${ref.schema}"`);
  }
}

function runtimeMutationTargets(statement: string): Array<{ schema: string | null; table: string }> {
  const tokens = tokenizeSqlRelations(statement);
  const targets: Array<{ schema: string | null; table: string }> = [];
  const keywordAt = (index: number, keyword: string) => tokens[index]?.value === keyword && !tokens[index]?.quoted;
  const readTarget = (start: number) => {
    let cursor = start;
    if (keywordAt(cursor, "only")) cursor += 1;
    const parenthesized = isSqlSymbol(tokens[cursor], "(");
    if (parenthesized) cursor += 1;
    if (!tokens[cursor]?.identifier) return null;
    const names = [tokens[cursor]!.value];
    cursor += 1;
    while (isSqlSymbol(tokens[cursor], ".") && tokens[cursor + 1]?.identifier) {
      names.push(tokens[cursor + 1]!.value);
      cursor += 2;
    }
    if (parenthesized) {
      if (!isSqlSymbol(tokens[cursor], ")")) return null;
      cursor += 1;
    }
    if (isSqlSymbol(tokens[cursor], "*")) cursor += 1;
    return { schema: names.length > 1 ? names.slice(0, -1).join(".") : null, table: names.at(-1)!, cursor };
  };
  for (let index = 0; index < tokens.length; index += 1) {
    let start: number;
    if (keywordAt(index, "insert") && keywordAt(index + 1, "into")) start = index + 2;
    else if (keywordAt(index, "delete") && keywordAt(index + 1, "from")) start = index + 2;
    else if (keywordAt(index, "update")) {
      if (["do", "for", "on"].some((keyword) => keywordAt(index - 1, keyword))
        || (keywordAt(index - 3, "for") && keywordAt(index - 2, "no") && keywordAt(index - 1, "key"))) continue;
      start = index + 1;
    } else continue;
    const target = readTarget(start);
    if (!target) continue;
    if (keywordAt(index, "update")) {
      let cursor = target.cursor;
      if (keywordAt(cursor, "as")) cursor += 2;
      else if (!keywordAt(cursor, "set") && tokens[cursor]?.identifier) cursor += 1;
      if (!keywordAt(cursor, "set")) continue;
    }
    targets.push({ schema: target.schema, table: target.table });
  }
  return targets;
}

function assertMigrationCommentNamespace(statement: string, namespace: string): void {
  const tokens = tokenizeSqlRelations(statement);
  if (tokens[0]?.value !== "comment" || tokens[0]?.quoted) return;
  const kind = tokens[2]?.value;
  const expectedParts = kind === "column" ? 3 : kind === "schema" ? 1 : 2;
  const supported = ["table", "column", "index", "sequence", "schema"].includes(kind ?? "");
  const names: string[] = [];
  let cursor = 3;
  if (tokens[cursor]?.identifier) {
    names.push(tokens[cursor]!.value);
    cursor += 1;
    while (isSqlSymbol(tokens[cursor], ".") && tokens[cursor + 1]?.identifier) {
      names.push(tokens[cursor + 1]!.value);
      cursor += 2;
    }
  }
  if (tokens[1]?.value !== "on" || tokens[1]?.quoted || tokens[2]?.quoted || !supported
    || names.length !== expectedParts || names[0] !== namespace || tokens[cursor]?.value !== "is" || tokens[cursor]?.quoted) {
    throw new Error(`Plugin migration comments must target a supported object in namespace "${namespace}"`);
  }
}

function migrationTargets(statement: string, namespace: string): SqlRef[] {
  const tokens = tokenizeSqlRelations(statement);
  const keywordAt = (index: number, keyword: string) => tokens[index]?.value === keyword && !tokens[index]?.quoted;
  const unsupported = () => new Error("Plugin migrations only support CREATE TABLE, CREATE INDEX, ALTER TABLE, and scoped COMMENT statements");
  let cursor = 0;
  const readName = (): string[] => {
    const names: string[] = [];
    if (!tokens[cursor]?.identifier) throw unsupported();
    names.push(tokens[cursor]!.value);
    cursor += 1;
    while (isSqlSymbol(tokens[cursor], ".") && tokens[cursor + 1]?.identifier) {
      names.push(tokens[cursor + 1]!.value);
      cursor += 2;
    }
    return names;
  };
  const requireOwned = (names: readonly string[], keyword: string): SqlRef => {
    if (names.length !== 2) throw new Error("Plugin migration targets must use fully qualified schema names");
    if (names[0] !== namespace) {
      throw new Error(`Plugin migration target schema "${names[0]}" is outside namespace "${namespace}"`);
    }
    return { keyword, schema: names[0]!, table: names[1]! };
  };
  const skipIfExists = (allowNot: boolean) => {
    if (!keywordAt(cursor, "if")) return;
    cursor += 1;
    if (allowNot && keywordAt(cursor, "not")) cursor += 1;
    if (!keywordAt(cursor, "exists")) throw unsupported();
    cursor += 1;
  };
  const validateSequenceOptions = (index: number) => {
    if (keywordAt(index, "sequence") && keywordAt(index + 1, "name")) {
      // Identity sequences are separate schema objects, even when their
      // parent table is owned by the plugin. This also covers ALTER COLUMN
      // ADD GENERATED and ALTER COLUMN SET SEQUENCE NAME.
      const savedCursor = cursor;
      cursor = index + 2;
      requireOwned(readName(), "identity_sequence");
      cursor = savedCursor;
    }
    if (keywordAt(index, "owned") && keywordAt(index + 1, "by")) {
      throw new Error("Plugin migrations cannot override sequence ownership");
    }
  };
  const validateNestedObjects = (start: number, table: boolean) => {
    let depth = 0;
    let queryBody = false;
    for (let index = start; index < tokens.length; index += 1) {
      if (!queryBody && depth === 0 && keywordAt(index, "as")) {
        if (!["select", "table", "with", "values"].some((keyword) => keywordAt(index + 1, keyword))
          && !isSqlSymbol(tokens[index + 1], "(")) {
          throw new Error("Plugin migrations require explicit query sources for CREATE TABLE AS");
        }
        queryBody = true;
      }
      if (!queryBody) validateSequenceOptions(index);
      if (!queryBody && ((depth === 0 && keywordAt(index, "tablespace"))
        || (keywordAt(index, "using") && keywordAt(index + 1, "index") && keywordAt(index + 2, "tablespace")))) {
        throw new Error("Plugin migrations cannot select tablespaces");
      }
      if (!queryBody && depth === 0 && keywordAt(index, "using")) {
        throw new Error("Plugin migrations cannot select table or index access methods");
      }
      // LIKE can copy stored callbacks and other object definitions that do
      // not appear in the statement text. Require explicit table definitions.
      if (table && !queryBody && depth === 1 && keywordAt(index, "like")) {
        throw new Error("Plugin migrations cannot clone table definitions with LIKE");
      }
      if (isSqlSymbol(tokens[index], "(")) depth += 1;
      else if (isSqlSymbol(tokens[index], ")")) depth -= 1;
    }
  };
  if (keywordAt(0, "comment")) {
    assertMigrationCommentNamespace(statement, namespace);
    return ["table", "column"].includes(tokens[2]!.value)
      ? [{ keyword: "table_target", schema: tokens[3]!.value, table: tokens[5]!.value }] : [];
  }
  if (keywordAt(0, "create")) {
    cursor = 1;
    const unique = keywordAt(cursor, "unique");
    if (unique) cursor += 1;
    if (keywordAt(cursor, "table") && !unique) {
      cursor += 1;
      skipIfExists(true);
      const target = requireOwned(readName(), "new_table");
      validateNestedObjects(cursor, true);
      if (!isSqlSymbol(tokens[cursor], "(") && !keywordAt(cursor, "as")) throw unsupported();
      return [target];
    }
    if (keywordAt(cursor, "index")) {
      cursor += 1;
      skipIfExists(true);
      const indexName = readName();
      if (indexName.length > 1) requireOwned(indexName, "index_target");
      if (!keywordAt(cursor, "on")) throw unsupported();
      cursor += 1;
      if (keywordAt(cursor, "only")) cursor += 1;
      const target = requireOwned(readName(), "on");
      validateNestedObjects(cursor, false);
      return [target];
    }
  }
  if (keywordAt(0, "alter") && keywordAt(1, "table")) {
    cursor = 2;
    skipIfExists(false);
    if (keywordAt(cursor, "only")) cursor += 1;
    const parenthesized = isSqlSymbol(tokens[cursor], "(");
    if (parenthesized) cursor += 1;
    const target = requireOwned(readName(), "table_target");
    if (parenthesized) {
      if (!isSqlSymbol(tokens[cursor], ")")) throw unsupported();
      cursor += 1;
    }
    if (isSqlSymbol(tokens[cursor], "*")) cursor += 1;
    // The ALTER action allowlist below rejects table-level administrative
    // changes. Nested identity options still need their own target checks.
    for (let index = cursor; index < tokens.length; index += 1) {
      validateSequenceOptions(index);
      if (keywordAt(index, "using") && keywordAt(index + 1, "index") && keywordAt(index + 2, "tablespace")) {
        throw new Error("Plugin migrations cannot select tablespaces");
      }
    }
    while (cursor < tokens.length) {
      if (!keywordAt(cursor, "add") && !(keywordAt(cursor, "alter") && keywordAt(cursor + 1, "column"))
        && !(keywordAt(cursor, "drop") && keywordAt(cursor + 1, "constraint"))) {
        throw new Error("Plugin ALTER TABLE migrations only support column and constraint changes");
      }
      let depth = 0;
      do {
        if (isSqlSymbol(tokens[cursor], "(") || isSqlSymbol(tokens[cursor], "[")) depth += 1;
        else if (isSqlSymbol(tokens[cursor], ")") || isSqlSymbol(tokens[cursor], "]")) depth -= 1;
        cursor += 1;
      } while (cursor < tokens.length && !(depth === 0 && isSqlSymbol(tokens[cursor], ",")));
      if (isSqlSymbol(tokens[cursor], ",")) cursor += 1;
    }
    return [target];
  }
  throw unsupported();
}

function assertAllowedPublicRead(
  ref: SqlRef,
  allowedCoreReadTables: ReadonlySet<string>,
): void {
  if (ref.schema !== "public") return;
  if (!allowedCoreReadTables.has(ref.table)) {
    throw new Error(`Plugin SQL references public.${ref.table}, which is not whitelisted`);
  }
  if (!["from", "join", "table", "references"].includes(ref.keyword)) {
    throw new Error(`Plugin SQL cannot mutate or define objects in public.${ref.table}`);
  }
}

function assertNoBannedSql(statement: string): void {
  const normalized = normaliseSql(statement);
  const banned = [
    /\bcreate\s+extension\b/,
    /\bcreate\s+(?:event\s+)?trigger\b/,
    /\bcreate\s+(?:or\s+replace\s+)?rule\b/,
    /\b(?:enable|disable)\s+(?:(?:always|replica)\s+)?rule\b/,
    /\bcreate\s+(?:or\s+replace\s+)?function\b/,
    /\bcreate\s+language\b/,
    /\bgrant\b/,
    /\brevoke\b/,
    /\bsecurity\s+definer\b/,
    /\bcopy\b/,
    /\bcall\b/,
    /\bdo\s+(?:e?''|language\b)/,
  ];
  const matched = banned.find((pattern) => pattern.test(normalized));
  if (matched) {
    throw new Error(`Plugin SQL contains a disallowed statement or clause: ${matched.source}`);
  }
}

export function validatePluginMigrationStatement(
  statement: string,
  namespace: string,
  coreReadTables: readonly PluginDatabaseCoreReadTable[] = [],
): void {
  assertIdentifier(namespace, "namespace");
  assertNoBannedSql(statement);

  const normalized = normaliseSql(statement);
  if (/^\s*(drop|truncate)\b/.test(normalized)) {
    throw new Error("Destructive plugin migrations are not allowed in Phase 1");
  }
  if (/^create\s+(?:or\s+replace\s+)?(?:(?:temp|temporary)\s+)?(?:recursive\s+)?(?:materialized\s+)?view\b/.test(normalized)) {
    throw new Error("Plugin migrations cannot create views");
  }
  if (/\b(?:attach|detach)\s+partition\b/.test(normalized)) {
    throw new Error("Plugin migrations cannot attach or detach partitions");
  }
  if (/\bpartition\s+of\b/.test(normalized)) {
    throw new Error("Plugin migrations cannot create table partitions");
  }
  if (/\binherits?\b/.test(normalized)) {
    throw new Error("Plugin migrations cannot change table inheritance");
  }
  if (/\bset\s+schema\b/.test(normalized)) {
    throw new Error("Plugin migrations cannot move objects between schemas");
  }
  assertMigrationCommentNamespace(statement, namespace);
  const tokens = tokenizeSqlRelations(statement);
  if (tokens.some((token, index) => !token.quoted && ["insert", "update", "delete", "merge"].includes(token.value)
    && !(tokens[index - 1]?.value === "on" && !tokens[index - 1]?.quoted && ["update", "delete"].includes(token.value)))) {
    throw new Error("Plugin migrations cannot contain data-changing statements or clauses");
  }
  migrationTargets(statement, namespace);
  validatePluginSqlFunctions(statement);
  const allowedCoreReadTables = new Set(coreReadTables);
  // ALTER COLUMN ... USING is an expression, while FROM/JOIN/TABLE and
  // REFERENCES still introduce persistent relations inside migration DDL.
  assertRuntimeRelationsQualified(statement, namespace, allowedCoreReadTables, false);
}

export function validatePluginRuntimeQuery(
  query: string,
  namespace: string,
  coreReadTables: readonly PluginDatabaseCoreReadTable[] = [],
): void {
  const statements = splitSqlStatements(query);
  if (statements.length !== 1) {
    throw new Error("Plugin runtime SQL must contain exactly one statement");
  }
  const statement = statements[0]!;
  assertNoBannedSql(statement);
  const normalized = normaliseSql(statement);
  if (!normalized.startsWith("select ") && !normalized.startsWith("with ")) {
    throw new Error("ctx.db.query only allows SELECT statements");
  }
  if (/\b(insert|update|delete|merge|alter|create|drop|truncate)\b/.test(normalized)) {
    throw new Error("ctx.db.query cannot contain mutation or DDL keywords");
  }
  if (/\binto\b/.test(normalized)) {
    throw new Error("ctx.db.query cannot contain SELECT INTO");
  }
  validatePluginSqlFunctions(statement);

  const allowedCoreReadTables = new Set(coreReadTables);
  assertRuntimeRelationsQualified(statement, namespace, allowedCoreReadTables);
}

function assertRuntimeExecuteCommand(statement: string): void {
  const tokens = tokenizeSqlRelations(statement);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const previous = tokens[index - 1];
    if (!token.quoted && token.value === "into" && (previous?.value !== "insert" || previous.quoted)) {
      throw new Error("ctx.db.execute cannot contain SELECT INTO");
    }
  }
  if (tokens[0]?.value !== "with" || tokens[0]?.quoted) return;

  // Only the final, outer command determines what a WITH statement does.
  // A mutation inside a CTE must not authorize another kind of command.
  let cursor = tokens[1]?.value === "recursive" && !tokens[1]?.quoted ? 2 : 1;
  const skipGroup = (): boolean => {
    if (!isSqlSymbol(tokens[cursor], "(")) return false;
    let depth = 0;
    do {
      if (isSqlSymbol(tokens[cursor], "(")) depth += 1;
      else if (isSqlSymbol(tokens[cursor], ")")) depth -= 1;
      cursor += 1;
    } while (cursor < tokens.length && depth > 0);
    return depth === 0;
  };
  while (tokens[cursor]?.identifier) {
    cursor += 1;
    if (isSqlSymbol(tokens[cursor], "(") && !skipGroup()) break;
    if (tokens[cursor]?.value !== "as" || tokens[cursor]?.quoted) break;
    cursor += 1;
    if (tokens[cursor]?.value === "not" && !tokens[cursor]?.quoted) cursor += 1;
    if (tokens[cursor]?.value === "materialized" && !tokens[cursor]?.quoted) cursor += 1;
    if (!skipGroup()) break;
    if (!isSqlSymbol(tokens[cursor], ",")) {
      const command = tokens[cursor];
      if (command && !command.quoted && ["insert", "update", "delete"].includes(command.value)) return;
      break;
    }
    cursor += 1;
  }
  throw new Error("ctx.db.execute WITH statements must finish with INSERT, UPDATE, or DELETE");
}

export function validatePluginRuntimeExecute(query: string, namespace: string): void {
  const statements = splitSqlStatements(query);
  if (statements.length !== 1) {
    throw new Error("Plugin runtime SQL must contain exactly one statement");
  }
  const statement = statements[0]!;
  assertNoBannedSql(statement);
  const normalized = normaliseSql(statement);
  if (!/^(insert\s+into|update|delete\s+from|with\b)/.test(normalized)) {
    throw new Error("ctx.db.execute only allows INSERT, UPDATE, or DELETE");
  }
  if (/\bmerge\s+into\b/.test(normalized)) {
    throw new Error("ctx.db.execute cannot contain MERGE statements");
  }
  if (normalized.startsWith("with ") && !/\b(insert\s+into|update|delete\s+from)\b/.test(normalized)) {
    throw new Error("ctx.db.execute WITH statements must perform an INSERT, UPDATE, or DELETE");
  }
  assertRuntimeExecuteCommand(statement);
  if (/\b(alter|create|drop|truncate)\b/.test(normalized)) {
    throw new Error("ctx.db.execute cannot contain DDL keywords");
  }
  validatePluginSqlFunctions(statement);

  const targets = runtimeMutationTargets(statement);
  if (targets.length === 0 || targets.some((target) => target.schema !== namespace.toLowerCase())) {
    throw new Error(`ctx.db.execute target must be inside plugin namespace "${namespace}"`);
  }
  assertRuntimeRelationsQualified(statement, namespace);
}

function bindSql(statement: string, params: readonly unknown[] = []): SQL {
  // Safe only after callers run the plugin SQL validators above.
  const chunks: SQL[] = [];
  let cursor = 0;
  const placeholderPattern = /\$(\d+)/g;
  const seen = new Set<number>();

  const placeholders: Array<{ raw: string; number: string; index: number }> = [];
  let segmentOffset = 0;
  for (const segment of scanSql(statement)) {
    if (segment.kind === "code") {
      for (const match of segment.raw.matchAll(placeholderPattern)) {
        if (isSqlIdentifierPart(segment.raw[match.index! - 1])) continue;
        placeholders.push({
          raw: match[0],
          number: match[1]!,
          index: segmentOffset + match.index!,
        });
      }
    }
    segmentOffset += segment.raw.length;
  }

  for (const placeholder of placeholders) {
    const index = Number(placeholder.number);
    if (!Number.isInteger(index) || index < 1 || index > params.length) {
      throw new Error(`SQL placeholder $${placeholder.number} has no matching parameter`);
    }
    chunks.push(sql.raw(statement.slice(cursor, placeholder.index)));
    chunks.push(sql`${params[index - 1]}`);
    seen.add(index);
    cursor = placeholder.index + placeholder.raw.length;
  }
  if (params.length === 0) return sql.raw(statement);
  chunks.push(sql.raw(statement.slice(cursor)));
  if (seen.size !== params.length) {
    throw new Error("Every ctx.db parameter must be referenced by a $n placeholder");
  }
  return sql.join(chunks, sql.raw(""));
}

async function listSqlMigrationFiles(migrationsDir: string): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Fingerprint of a migration file with its line endings made uniform, so the
 * same file checked out on Windows (CRLF) and on Linux (LF) is one migration,
 * not a "changed" one.
 */
export function migrationChecksum(content: string): string {
  return sha256(content.replace(/\r\n/g, "\n"));
}

/**
 * Every fingerprint an already-applied migration may have been recorded with:
 * the current line-ending-neutral one, plus the raw-bytes fingerprints older
 * builds stored, for either line ending. A real edit to the SQL matches none.
 */
export function acceptedMigrationChecksums(content: string): string[] {
  const lf = content.replace(/\r\n/g, "\n");
  return [...new Set([migrationChecksum(content), sha256(content), sha256(lf), sha256(lf.replace(/\n/g, "\r\n"))])];
}

function resolveMigrationsDir(packageRoot: string, migrationsDir: string): string {
  const resolvedRoot = path.resolve(packageRoot);
  const resolvedDir = path.resolve(resolvedRoot, migrationsDir);
  const relative = path.relative(resolvedRoot, resolvedDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Plugin migrationsDir escapes package root: ${migrationsDir}`);
  }
  return resolvedDir;
}

export function pluginDatabaseService(db: Db) {
  async function assertRuntimePluginTables(
    namespace: string,
    statement: string,
    includeTargets = false,
    executor: Pick<Db, "execute"> = db,
    migration = false,
  ): Promise<void> {
    const tableNames = new Set(extractRuntimeRelationRefs(tokenizeSqlRelations(statement), !migration)
      .filter((ref) => ref.schema === namespace && (!migration || !["new_table", "references"].includes(ref.keyword)))
      .map((ref) => ref.table));
    const writeTableNames = new Set<string>();
    if (includeTargets) {
      for (const target of runtimeMutationTargets(statement)) {
        tableNames.add(target.table);
        writeTableNames.add(target.table);
      }
    }
    if (migration) {
      for (const ref of migrationTargets(statement, namespace)) {
        if (ref.keyword !== "new_table") {
          tableNames.add(ref.table);
          writeTableNames.add(ref.table);
        }
      }
    }
    if (tableNames.size === 0) return;
    const tableList = sql.join([...tableNames].map((name) => sql`${name}`), sql`, `);
    const result = await executor.execute(sql`
      SELECT c.relname, c.relkind,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_inherits i
          WHERE i.inhparent = c.oid OR i.inhrelid = c.oid
        ) AS has_inheritance,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
        ) AS has_user_triggers,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class = c.oid
        ) AS has_rules,
        ARRAY(
          SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid)
          FROM pg_catalog.pg_attrdef d
          JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
          WHERE d.adrelid = c.oid AND a.attgenerated = ''
        ) AS default_expressions,
        ARRAY(
          SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid)
          FROM pg_catalog.pg_attrdef d
          JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
          WHERE d.adrelid = c.oid AND a.attgenerated <> ''
          UNION ALL
          SELECT pg_catalog.pg_get_expr(k.conbin, k.conrelid)
          FROM pg_catalog.pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'c'
          UNION ALL
          SELECT pg_catalog.pg_get_expr(i.indexprs, i.indrelid)
          FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid AND i.indexprs IS NOT NULL
          UNION ALL
          SELECT pg_catalog.pg_get_expr(i.indpred, i.indrelid)
          FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid AND i.indpred IS NOT NULL
        ) AS stored_expressions
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${namespace} AND c.relname IN (${tableList})
    `);
    const relations = Array.from(result as Iterable<{
      relname: string; relkind: string; has_inheritance: boolean;
      has_user_triggers: boolean; has_rules: boolean; default_expressions: string[]; stored_expressions: string[];
    }>);
    const ordinaryTables = new Set(relations.filter((relation) => relation.relkind === "r" && !relation.has_inheritance)
      .map((relation) => relation.relname));
    if ([...tableNames].some((name) => !ordinaryTables.has(name))) {
      throw new Error("Plugin runtime SQL relations must be ordinary plugin-owned tables without inheritance");
    }
    for (const relation of relations) {
      if (relation.has_user_triggers || relation.has_rules) {
        throw new Error("Plugin SQL relations cannot contain user-defined triggers or rewrite rules");
      }
      for (const expression of relation.stored_expressions) validatePluginSqlFunctions(expression);
      // Reading existing rows does not evaluate column defaults. For writes,
      // serial defaults have one narrowly scoped exception to the function
      // allowlist: a static regclass constant naming a namespace sequence.
      if (writeTableNames.has(relation.relname)) {
        for (const expression of relation.default_expressions) {
          const nextval = expression.match(/^\s*(?:pg_catalog\.)?nextval\(\s*'((?:[^']|'')*)'\s*::\s*(?:pg_catalog\.)?regclass\s*\)\s*$/);
          if (!nextval) {
            validatePluginSqlFunctions(expression);
            continue;
          }
          const sequence = await executor.execute(sql`
            SELECT c.oid FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE c.oid = pg_catalog.to_regclass(${nextval[1]!.replaceAll("''", "'")})
              AND c.relkind = 'S' AND n.nspname = ${namespace}
          `);
          if (Array.from(sequence as Iterable<unknown>).length !== 1) {
            throw new Error("Plugin column defaults may only advance an ordinary sequence in the plugin namespace");
          }
        }
      }
    }
  }

  async function getPluginRecord(pluginId: string) {
    const rows = await db.select().from(plugins).where(eq(plugins.id, pluginId)).limit(1);
    const plugin = rows[0];
    if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);
    return plugin;
  }

  async function ensureNamespace(pluginId: string, manifest: PaperclipPluginManifestV1) {
    if (!manifest.database) return null;
    const namespaceName = derivePluginDatabaseNamespace(
      manifest.id,
      manifest.database.namespaceSlug,
    );
    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(namespaceName)}`));
    const rows = await db
      .insert(pluginDatabaseNamespaces)
      .values({
        pluginId,
        pluginKey: manifest.id,
        namespaceName,
        namespaceMode: "schema",
        status: "active",
      })
      .onConflictDoUpdate({
        target: pluginDatabaseNamespaces.pluginId,
        set: {
          pluginKey: manifest.id,
          namespaceName,
          namespaceMode: "schema",
          status: "active",
          updatedAt: new Date(),
        },
      })
      .returning();
    return rows[0] ?? null;
  }

  async function getNamespace(pluginId: string) {
    const rows = await db
      .select()
      .from(pluginDatabaseNamespaces)
      .where(eq(pluginDatabaseNamespaces.pluginId, pluginId))
      .limit(1);
    return rows[0] ?? null;
  }

  async function getRuntimeNamespace(pluginId: string) {
    const namespace = await getNamespace(pluginId);
    if (!namespace || namespace.status !== "active") {
      throw new Error("Plugin database namespace is not active");
    }
    return namespace.namespaceName;
  }

  async function recordMigrationFailure(input: {
    pluginId: string;
    pluginKey: string;
    namespaceName: string;
    migrationKey: string;
    checksum: string;
    pluginVersion: string;
    error: unknown;
  }): Promise<void> {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    await db
      .insert(pluginMigrations)
      .values({
        pluginId: input.pluginId,
        pluginKey: input.pluginKey,
        namespaceName: input.namespaceName,
        migrationKey: input.migrationKey,
        checksum: input.checksum,
        pluginVersion: input.pluginVersion,
        status: "failed",
        errorMessage: message,
      })
      .onConflictDoUpdate({
        target: [pluginMigrations.pluginId, pluginMigrations.migrationKey],
        set: {
          checksum: input.checksum,
          pluginVersion: input.pluginVersion,
          status: "failed",
          errorMessage: message,
          startedAt: new Date(),
          appliedAt: null,
        },
      });
    await db
      .update(pluginDatabaseNamespaces)
      .set({ status: "migration_failed", updatedAt: new Date() })
      .where(eq(pluginDatabaseNamespaces.pluginId, input.pluginId));
  }

  return {
    ensureNamespace,

    async applyMigrations(pluginId: string, manifest: PaperclipPluginManifestV1, packageRoot: string) {
      if (!manifest.database) return null;
      const namespace = await ensureNamespace(pluginId, manifest);
      if (!namespace) return null;

      const migrationDir = resolveMigrationsDir(packageRoot, manifest.database.migrationsDir);
      const migrationFiles = await listSqlMigrationFiles(migrationDir);
      const coreReadTables = manifest.database.coreReadTables ?? [];
      const lockKey = Number.parseInt(createHash("sha256").update(pluginId).digest("hex").slice(0, 12), 16);

      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
        for (const migrationKey of migrationFiles) {
          const content = await readFile(path.join(migrationDir, migrationKey), "utf8");
          const checksum = migrationChecksum(content);
          const existingRows = await tx
            .select()
            .from(pluginMigrations)
            .where(and(eq(pluginMigrations.pluginId, pluginId), eq(pluginMigrations.migrationKey, migrationKey)))
            .limit(1);
          const existing = existingRows[0] as PluginMigrationRecord | undefined;
          if (existing?.status === "applied") {
            if (!acceptedMigrationChecksums(content).includes(existing.checksum)) {
              throw new Error(`Plugin migration checksum mismatch for ${migrationKey}`);
            }
            continue;
          }

          const statements = splitSqlStatements(content);
          try {
            if (statements.length === 0) {
              throw new Error(`Plugin migration ${migrationKey} is empty`);
            }
            for (const statement of statements) {
              validatePluginMigrationStatement(statement, namespace.namespaceName, coreReadTables);
              await assertRuntimePluginTables(namespace.namespaceName, statement, false, tx, true);
              await tx.execute(sql.raw(statement));
            }
            await tx
              .insert(pluginMigrations)
              .values({
                pluginId,
                pluginKey: manifest.id,
                namespaceName: namespace.namespaceName,
                migrationKey,
                checksum,
                pluginVersion: manifest.version,
                status: "applied",
                appliedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [pluginMigrations.pluginId, pluginMigrations.migrationKey],
                set: {
                  checksum,
                  pluginVersion: manifest.version,
                  status: "applied",
                  errorMessage: null,
                  startedAt: new Date(),
                  appliedAt: new Date(),
                },
              });
          } catch (error) {
            await recordMigrationFailure({
              pluginId,
              pluginKey: manifest.id,
              namespaceName: namespace.namespaceName,
              migrationKey,
              checksum,
              pluginVersion: manifest.version,
              error,
            });
            throw error;
          }
        }
      });

      return namespace;
    },

    getRuntimeNamespace,

    async query<T = Record<string, unknown>>(pluginId: string, statement: string, params?: unknown[]): Promise<T[]> {
      const plugin = await getPluginRecord(pluginId);
      const namespace = await getRuntimeNamespace(pluginId);
      validatePluginRuntimeQuery(statement, namespace, plugin.manifestJson.database?.coreReadTables ?? []);
      await assertRuntimePluginTables(namespace, statement);
      const result = await db.execute(bindSql(statement, params));
      return Array.from(result as Iterable<T>);
    },

    async execute(pluginId: string, statement: string, params?: unknown[]): Promise<{ rowCount: number }> {
      const namespace = await getRuntimeNamespace(pluginId);
      validatePluginRuntimeExecute(statement, namespace);
      await assertRuntimePluginTables(namespace, statement, true);
      const result = await db.execute(bindSql(statement, params));
      return { rowCount: Number((result as { count?: number | string }).count ?? 0) };
    },
  };
}
