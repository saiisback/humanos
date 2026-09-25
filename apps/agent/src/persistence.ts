import { postgres } from "@flue/postgres";
import { Pool } from "pg";
export function createPersistence(connectionString: string, schema = "public") {
  if (!connectionString)
    throw new Error("DATABASE_URL is required for durable agent persistence");
  if (!/^[a-z_][a-z0-9_]*$/.test(schema))
    throw new Error("Invalid persistence schema");
  const pool = new Pool({
    connectionString,
    options: `-c search_path=${schema},public`,
  });
  return postgres({
    query: async (text, params) => (await pool.query(text, params)).rows,
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: async (t, p) => (await client.query(t, p)).rows,
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  });
}
