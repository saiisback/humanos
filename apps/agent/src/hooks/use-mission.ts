import { useAgentStart, usePersistentState } from "@flue/runtime";
import { Pool } from "pg";
import type { Mission } from "@humanos/schemas";
export function useMission(id: string): Mission | null {
  const [mission, setMission] = usePersistentState<Mission | null>(
    "mission",
    null,
  );
  useAgentStart(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    });
    try {
      const result = await pool.query<{ data: Mission }>(
        "SELECT data FROM missions WHERE id=$1",
        [id],
      );
      const current = result.rows[0]?.data;
      if (!current) throw new Error("Mission not found");
      setMission(current);
    } finally {
      await pool.end();
    }
  });
  return mission;
}
