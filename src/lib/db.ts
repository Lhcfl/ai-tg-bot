import type { Database as BunDatabase } from "bun:sqlite";

type ColumnType = "INTEGER" | "TEXT" | "REAL" | "BLOB";

type SQLiteValue = string | number | boolean | null | Uint8Array;

type InferTSType<T extends ColumnType> = T extends "INTEGER"
  ? number
  : T extends "TEXT"
    ? string
    : T extends "REAL"
      ? number
      : T extends "BLOB"
        ? Uint8Array
        : never;

interface ColumnDef<T extends ColumnType = ColumnType> {
  type: T;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  notNull?: boolean;
  unique?: boolean;
  default?: SQLiteValue;
}

interface IndexDef {
  columns: string[];
  unique?: boolean;
}

type SchemaDefinition = Record<string, ColumnDef>;

type InferRowType<T extends SchemaDefinition> = {
  [K in keyof T]:
    | InferTSType<T[K]["type"]>
    | (T[K]["notNull"] extends true ? never : null);
};

type QueryResult<T> = T[];

interface QueryMethods<Schema extends SchemaDefinition> {
  sql<T = InferRowType<Schema>>(
    strings: TemplateStringsArray,
    ...values: SQLiteValue[]
  ): QueryResult<T>;
}

/**
 * Validate SQL identifier (table name, column name, index name)
 * Prevents SQL injection by ensuring only valid identifiers are used
 */
function validateIdentifier(name: string, type: string): void {
  // SQLite identifiers can contain: letters, digits, underscore
  // Must start with a letter or underscore
  const validPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

  if (!validPattern.test(name)) {
    throw new Error(
      `Invalid ${type} name "${name}". SQL identifiers must start with a letter or underscore and contain only letters, numbers, and underscores.`,
    );
  }

  // Reject SQL keywords that could be dangerous
  const dangerousKeywords = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "DROP",
    "CREATE",
    "ALTER",
    "EXEC",
    "EXECUTE",
    "UNION",
    "WHERE",
    "OR",
    "AND",
  ];

  if (dangerousKeywords.includes(name.toUpperCase())) {
    throw new Error(
      `Invalid ${type} name "${name}". Cannot use SQL keyword as identifier.`,
    );
  }
}

export class TableBuilder<Schema extends SchemaDefinition> {
  private tableName: string;
  private schema: Schema;
  private indices: Map<string, IndexDef>;
  private db!: BunDatabase;

  constructor(tableName: string, schema: Schema) {
    validateIdentifier(tableName, "table");
    this.tableName = tableName;
    this.schema = schema;
    this.indices = new Map();

    // Validate all column names
    for (const colName of Object.keys(schema)) {
      validateIdentifier(colName, "column");
    }
  }

  /**
   * Add an index to the table
   */
  index(name: string, columns: string[], unique = false): this {
    validateIdentifier(name, "index");
    for (const col of columns) {
      validateIdentifier(col, "column");
    }
    this.indices.set(name, { columns, unique });
    return this;
  }

  /**
   * Initialize the table - creates if not exists
   */
  init(db: BunDatabase): void {
    this.db = db;
    const columns: string[] = [];

    for (const [colName, colDef] of Object.entries(this.schema)) {
      const parts: string[] = [colName, colDef.type];

      if (colDef.primaryKey) {
        parts.push("PRIMARY KEY");
      }

      if (colDef.autoIncrement) {
        parts.push("AUTOINCREMENT");
      }

      if (colDef.notNull && !colDef.primaryKey) {
        parts.push("NOT NULL");
      }

      if (colDef.unique && !colDef.primaryKey) {
        parts.push("UNIQUE");
      }

      if (colDef.default !== undefined) {
        const defaultValue =
          typeof colDef.default === "string"
            ? `'${colDef.default.replace(/'/g, "''")}'` // Escape single quotes
            : colDef.default;
        parts.push(`DEFAULT ${defaultValue}`);
      }

      columns.push(parts.join(" "));
    }

    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        ${columns.join(",\n        ")}
      )
    `;

    this.db.run(createTableSQL);

    // Create indices
    for (const [indexName, indexDef] of this.indices) {
      const uniqueStr = indexDef.unique ? "UNIQUE " : "";
      const indexSQL = `
        CREATE ${uniqueStr}INDEX IF NOT EXISTS ${indexName} 
        ON ${this.tableName} (${indexDef.columns.join(", ")})
      `;
      this.db.run(indexSQL);
    }
  }

  private assertDb(): void {
    if (!this.db) {
      throw new Error(
        `Table "${this.tableName}" not initialized. Call init(db) first.`,
      );
    }
  }

  /**
   * Type-safe SQL query method
   */
  sql<T = InferRowType<Schema>>(
    strings: TemplateStringsArray,
    ...values: SQLiteValue[]
  ): QueryResult<T> {
    this.assertDb();
    // Build the query string
    let query = strings[0];
    for (let i = 0; i < values.length; i++) {
      query += `?${strings[i + 1]}`;
    }

    // Use prepared statement for safety
    const stmt = this.db.prepare(query || "");
    const result = stmt.all(...values) as T[];
    return result;
  }

  /**
   * Get all records
   */
  all(): QueryResult<InferRowType<Schema>> {
    this.assertDb();
    return this.sql`SELECT * FROM ${this.tableName}`;
  }

  /**
   * Query with WHERE clause (SELECT * FROM table WHERE ...)
   * @example
   * table.where`chat_id = ${123}`
   * table.where`chat_id = ${123} ORDER BY created_at DESC LIMIT 10`
   */
  where<T = InferRowType<Schema>>(
    strings: TemplateStringsArray,
    ...values: SQLiteValue[]
  ): QueryResult<T> {
    this.assertDb();
    // Build the WHERE clause
    let whereClause = strings[0];
    for (let i = 0; i < values.length; i++) {
      whereClause += `?${strings[i + 1]}`;
    }

    const query = `SELECT * FROM ${this.tableName} WHERE ${whereClause}`;
    const stmt = this.db.prepare(query);
    const result = stmt.all(...values) as T[];
    return result;
  }

  /**
   * Insert a record
   */
  insert(data: Partial<InferRowType<Schema>>): void {
    this.assertDb();
    const columns = Object.keys(data);

    // Validate column names (should already be validated, but double-check)
    for (const col of columns) {
      if (!(col in this.schema)) {
        throw new Error(
          `Column "${col}" does not exist in table "${this.tableName}" schema.`,
        );
      }
    }

    const placeholders = columns.map(() => "?").join(", ");
    const values = Object.values(data);

    const query = `INSERT INTO ${this.tableName} (${columns.join(", ")}) VALUES (${placeholders})`;
    const stmt = this.db.prepare(query);
    stmt.run(...values);
  }

  /**
   * Insert or update a record (UPSERT)
   * Uses ON CONFLICT to update on primary key conflict
   */
  upsert(data: Partial<InferRowType<Schema>>): void {
    this.assertDb();
    const columns = Object.keys(data);

    // Validate column names
    for (const col of columns) {
      if (!(col in this.schema)) {
        throw new Error(
          `Column "${col}" does not exist in table "${this.tableName}" schema.`,
        );
      }
    }

    const placeholders = columns.map(() => "?").join(", ");
    const values = Object.values(data);

    // Find primary key columns for conflict resolution
    const primaryKeys = Object.entries(this.schema)
      .filter(([_, def]) => def.primaryKey)
      .map(([name, _]) => name);

    if (primaryKeys.length === 0) {
      throw new Error(
        `Table "${this.tableName}" has no primary key. Cannot use upsert.`,
      );
    }

    // Build UPDATE SET clause (exclude primary keys from update)
    const updateSets = columns
      .filter((col) => !primaryKeys.includes(col))
      .map((col) => `${col} = excluded.${col}`)
      .join(", ");

    const query = `
      INSERT INTO ${this.tableName} (${columns.join(", ")})
      VALUES (${placeholders})
      ON CONFLICT(${primaryKeys.join(", ")}) DO UPDATE SET
        ${updateSets}
    `;

    const stmt = this.db.prepare(query);
    stmt.run(...values);
  }

  /**
   * Update records
   */
  update(
    data: Partial<InferRowType<Schema>>,
    where: string,
    ...whereValues: SQLiteValue[]
  ): void {
    this.assertDb();

    // Validate column names
    const columns = Object.keys(data);
    for (const col of columns) {
      if (!(col in this.schema)) {
        throw new Error(
          `Column "${col}" does not exist in table "${this.tableName}" schema.`,
        );
      }
    }

    const sets = columns.map((key) => `${key} = ?`).join(", ");
    const values = [...Object.values(data), ...whereValues];

    const query = `UPDATE ${this.tableName} SET ${sets} WHERE ${where}`;
    const stmt = this.db.prepare(query);
    stmt.run(...values);
  }

  /**
   * Delete records
   */
  delete(where: string, ...whereValues: SQLiteValue[]): void {
    this.assertDb();
    const query = `DELETE FROM ${this.tableName} WHERE ${where}`;
    const stmt = this.db.prepare(query);
    stmt.run(...whereValues);
  }

  /**
   * Get the underlying database instance
   */
  get database(): BunDatabase {
    return this.db;
  }

  /**
   * Get the table name
   */
  get name(): string {
    return this.tableName;
  }
}

/**
 * Create a type-safe table builder
 *
 * @example
 * ```ts
 * const usersTable = createTable("users", {
 *   id: { type: "INTEGER", primaryKey: true, autoIncrement: true },
 *   name: { type: "TEXT", notNull: true },
 *   email: { type: "TEXT", unique: true },
 *   created_at: { type: "INTEGER", default: Date.now() }
 * }).index("idx_email", ["email"]);
 *
 * usersTable.init(db);
 *
 * // Type-safe queries
 * const users = usersTable.sql`SELECT * FROM users WHERE id = ${1}`;
 * ```
 */
export function createTable<Schema extends SchemaDefinition>(
  tableName: string,
  schema: Schema,
): TableBuilder<Schema> {
  return new TableBuilder(tableName, schema);
}
