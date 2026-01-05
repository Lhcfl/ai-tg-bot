import type { SQL } from "bun";

type ColumnType = "INTEGER" | "TEXT" | "REAL" | "BLOB";

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
  default?: unknown;
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
    ...values: unknown[]
  ): Promise<QueryResult<T>>;
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
  public sql!: SQL;

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
  async init(db: SQL): Promise<void> {
    this.sql = db;
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

    await this.sql.unsafe(createTableSQL);

    // Create indices
    for (const [indexName, indexDef] of this.indices) {
      const uniqueStr = indexDef.unique ? "UNIQUE " : "";
      const indexSQL = `
        CREATE ${uniqueStr}INDEX IF NOT EXISTS ${indexName} 
        ON ${this.tableName} (${indexDef.columns.join(", ")})
      `;
      await this.sql.unsafe(indexSQL);
    }
  }

  /**
   * Get all records
   */
  async all(): Promise<QueryResult<InferRowType<Schema>>> {
    return this.sql`SELECT * FROM ${this.sql(this.tableName)}`;
  }

  /**
   * Query with WHERE clause (SELECT * FROM table WHERE ...)
   * @example
   * table.where`chat_id = ${123}`
   * table.where`chat_id = ${123} ORDER BY created_at DESC LIMIT 10`
   */
  async where<T = InferRowType<Schema>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await this
      .sql`SELECT * FROM ${this.sql(this.tableName)} WHERE ${this.sql(strings, ...values)}`;
    return result as T[];
  }

  /**
   * Update records
   */
  async update(data: Partial<InferRowType<Schema>>) {
    return {
      where: (arr: TemplateStringsArray, ...values: unknown[]) => {
        this.sql`UPDATE ${this.sql(this.tableName)} SET ${this.sql(
          data,
        )} WHERE ${this.sql(arr, ...values)}`;
      },
    };
  }

  /**
   * Delete records
   */
  async deleteWhere(
    arr: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<void> {
    return this
      .sql`DELETE FROM ${this.sql(this.tableName)} WHERE ${this.sql(arr, ...values)}`;
  }

  insert(data: Partial<Omit<InferRowType<Schema>, "id">>) {
    const columns = Object.keys(this.schema).filter((col) => col in data);
    const values = columns.map((col) => (data as Record<string, unknown>)[col]);
    // biome-ignore lint/suspicious/noExplicitAny: to bypass TemplateStringsArray typing
    const template: any = [
      "INSERT INTO ",
      `(${columns.join(",")}) VALUES (`,
      ...values.map((_) => ",").slice(1),
      ")",
    ];
    template.raw = template;
    return this.sql(template as never, this.sql(this.tableName), ...values);
  }

  async upsert(
    data: Omit<InferRowType<Schema>, "id">,
    conflict: string,
  ): Promise<void> {
    return this
      .sql`${this.insert(data)} ON CONFLICT(${this.sql(conflict)}) DO UPDATE SET ${this.sql(data)}`;
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
