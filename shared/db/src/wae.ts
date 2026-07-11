import type { AnyRelations, EmptyRelations } from 'drizzle-orm/relations';
import type { DrizzleSQLiteConfig } from 'drizzle-orm/sqlite-core';
import { drizzle as drizzleRest } from 'drizzle-orm/sqlite-proxy';
import { cstVisitor, parse as parseSql, show as showSql, type ParserOptions } from 'sql-parser-cst';
import type { Expr, Identifier, ListExpr, ParenExpr } from 'sql-parser-cst/lib/cst/Expr.js';
import type { Default, InsertClause, InsertStmt, ValuesClause } from 'sql-parser-cst/lib/cst/Insert.js';
import type * as waeSchema from './schemas/analyticsEngine.js';

const AE_PARSE_OPTS: ParserOptions = { dialect: 'sqlite', includeSpaces: true, includeNewlines: true, includeComments: true, paramTypes: ['?'] };
const AE_META_COLUMNS = new Set(['dataset', '_sample_interval', 'timestamp']);

/**
 * Inline-escapes a bound value for Analytics Engine SQL (no parameterised queries).
 * Strings are single-quoted with internal `'` doubled; numbers pass through;
 * null / undefined become the SQL keyword NULL.
 */
function aeEscapeValue(v: unknown): { type: string; text: string; [k: string]: unknown } {
	if (v === null || v === undefined) return { type: 'keyword', text: 'NULL', name: 'NULL' };
	if (typeof v === 'number') return { type: 'number_literal', text: String(v), value: v };
	if (typeof v === 'boolean') return { type: 'number_literal', text: v ? '1' : '0', value: v ? 1 : 0 };
	const s = String(v);
	return { type: 'string_literal', text: `'${s.replace(/'/g, "''")}'`, value: s };
}

/** Replace every `?` placeholder with the corresponding param value. */
function aeBindParams(sql: string, params: unknown[]): string {
	const ast = parseSql(sql, AE_PARSE_OPTS);
	let idx = 0;
	cstVisitor({
		parameter(node) {
			Object.assign(node, aeEscapeValue(params[idx++]));
		},
	})(ast);
	return showSql(ast);
}

/**
 * Detect statement type from raw SQL using sql-parser-cst.
 * Returns `'select'`, `'insert'`, or throws for unsupported types.
 */
function aeStatementType(sql: string): 'select' | 'insert' {
	const ast = parseSql(sql, AE_PARSE_OPTS);
	const stmt = ast.statements[0];
	if (!stmt) throw new Error('Analytics Engine: empty SQL statement');
	if (stmt.type === 'select_stmt') return 'select';
	if (stmt.type === 'insert_stmt') return 'insert';
	throw new Error(`Analytics Engine: unsupported statement type "${stmt.type}"`);
}

interface AEInsertParts {
	table: string;
	columns: string[];
	rows: unknown[][];
}

/** Extract table, column list, and value rows from a parameterised INSERT. */
function aeParseInsert(sql: string, params: unknown[]): AEInsertParts {
	const ast = parseSql(sql, { ...AE_PARSE_OPTS, paramTypes: ['?'] });
	const stmt = ast.statements[0] as InsertStmt;
	const insertClause = stmt.clauses.find((c): c is InsertClause => c.type === 'insert_clause');
	const valuesClause = stmt.clauses.find((c): c is ValuesClause => c.type === 'values_clause');
	if (!insertClause || !valuesClause) throw new Error('Analytics Engine: malformed INSERT');

	const table = (insertClause.table as Identifier).name ?? (insertClause.table as Identifier).text;
	const columns = insertClause.columns!.expr.items.map((i) => i.name ?? i.text);
	const valueRows: unknown[][] = [];

	for (const rowParenExpr of valuesClause.values.items as ParenExpr<ListExpr<Expr | Default>>[]) {
		const items = rowParenExpr.expr.items;
		let paramIdx = 0;
		const row = items.map((item) => {
			if (item.type === 'parameter') return params[paramIdx++];
			if (item.type === 'string_literal') return item.value;
			if (item.type === 'number_literal') return item.value;
			if (item.type === 'null_literal') return null;
			return null;
		});
		valueRows.push(row);
	}

	return { table, columns, rows: valueRows };
}

/** Map parsed INSERT columns + values to an `AnalyticsEngineDataPoint`. */
function aeColumnsToDataPoint(columns: string[], values: unknown[]): AnalyticsEngineDataPoint {
	const indexes: (string | ArrayBuffer | null)[] = [];
	const blobs: (string | ArrayBuffer | null)[] = [];
	const doubles: number[] = [];

	// Determine the max blob/double/index slot numbers
	let maxBlob = 0,
		maxDouble = 0,
		maxIndex = 0;
	for (const col of columns) {
		if (AE_META_COLUMNS.has(col)) continue;
		const blobMatch = /^blob(\d+)$/i.exec(col);
		if (blobMatch) {
			maxBlob = Math.max(maxBlob, Number(blobMatch[1]));
			continue;
		}
		const doubleMatch = /^double(\d+)$/i.exec(col);
		if (doubleMatch) {
			maxDouble = Math.max(maxDouble, Number(doubleMatch[1]));
			continue;
		}
		const indexMatch = /^index(\d+)$/i.exec(col);
		if (indexMatch) {
			maxIndex = Math.max(maxIndex, Number(indexMatch[1]));
			continue;
		}
	}

	// Pre-fill arrays so positional slots are correct
	for (let i = 0; i < maxBlob; i++) blobs.push('');
	for (let i = 0; i < maxDouble; i++) doubles.push(0);
	for (let i = 0; i < maxIndex; i++) indexes.push(null);

	for (let i = 0; i < columns.length; i++) {
		const col = columns[i]!;
		if (AE_META_COLUMNS.has(col)) continue; // silently drop meta columns
		const v = values[i];

		const blobMatch = /^blob(\d+)$/i.exec(col);
		if (blobMatch) {
			blobs[Number(blobMatch[1]) - 1] = v == null ? '' : String(v);
			continue;
		}
		const doubleMatch = /^double(\d+)$/i.exec(col);
		if (doubleMatch) {
			doubles[Number(doubleMatch[1]) - 1] = v == null ? 0 : Number(v);
			continue;
		}
		const indexMatch = /^index(\d+)$/i.exec(col);
		if (indexMatch) {
			indexes[Number(indexMatch[1]) - 1] = v == null ? null : String(v);
			continue;
		}
	}

	return { indexes, blobs, doubles };
}

async function aeExecSelect(readClient: { accountId: string; apiKey: string }, sql: string, params: unknown[], method: string): Promise<{ rows: unknown[] }> {
	const boundSql = params.length > 0 ? aeBindParams(sql, params) : sql;

	const response = await fetch(new URL(['client', 'v4', 'accounts', readClient.accountId, 'analytics_engine', 'sql'].join('/'), 'https://api.cloudflare.com'), {
		method: 'POST',
		headers: { Authorization: `Bearer ${readClient.apiKey}` },
		body: boundSql,
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Analytics Engine query failed (${response.status}): ${body}`);
	}

	const json = await response.json<{
		meta: {
			name: string;
			type: 'UInt32' | 'String' | 'Float64' | 'DateTime';
		}[];
		data: {
			dataset: keyof typeof waeSchema;
			_sample_interval: number;
			timestamp: `${number}-${number}-${number} ${number}:${number}:${number}`;
			index1: string;
			blob1: string;
			blob2: string;
			blob3: string;
			blob4: string;
			blob5: string;
			blob6: string;
			blob7: string;
			blob8: string;
			blob9: string;
			blob10: string;
			blob11: string;
			blob12: string;
			blob13: string;
			blob14: string;
			blob15: string;
			blob16: string;
			blob17: string;
			blob18: string;
			blob19: string;
			blob20: string;
			double1: number;
			double2: number;
			double3: number;
			double4: number;
			double5: number;
			double6: number;
			double7: number;
			double8: number;
			double9: number;
			double10: number;
			double11: number;
			double12: number;
			double13: number;
			double14: number;
			double15: number;
			double16: number;
			double17: number;
			double18: number;
			double19: number;
			double20: number;
		}[];
		rows: number;
		rows_before_limit_at_least: number;
	}>();
	const columnNames = json.meta.map(({ name }) => name as keyof (typeof json.data)[number]);

	if (method === 'get') {
		const first = json.data[0];
		return { rows: first ? columnNames.map((c) => first[c]) : [] };
	}

	return { rows: json.data.map((row) => columnNames.map((c) => row[c])) };
}

function aeExecInsert(writeBindings: Record<string, AnalyticsEngineDataset>, sql: string, params: unknown[]): { rows: [] } {
	const { table, columns, rows } = aeParseInsert(sql, params);
	const binding = writeBindings[table];
	if (!binding) throw new Error(`Analytics Engine: no write binding for dataset "${table}"`);

	for (const row of rows) {
		binding.writeDataPoint(aeColumnsToDataPoint(columns, row));
	}

	return { rows: [] };
}

export function drizzleAE<TRelations extends AnyRelations = EmptyRelations>(
	client: {
		read?: {
			accountId: string;
			apiKey: string;
		};
		write?: Partial<Record<keyof typeof waeSchema, AnalyticsEngineDataset>>;
	},
	config?: DrizzleSQLiteConfig<TRelations>,
) {
	return drizzleRest(async (sql, params, method) => {
		const type = aeStatementType(sql);
		if (type === 'select') {
			if (!client.read) throw new Error('Analytics Engine: read client not configured');
			return aeExecSelect(client.read, sql, params, method);
		}
		// insert
		if (!client.write) throw new Error('Analytics Engine: write bindings not configured');
		return aeExecInsert(client.write, sql, params);
	}, config);
}
