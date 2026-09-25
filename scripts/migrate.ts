import { Database } from "../packages/database/src/index.js";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const db = new Database(url);
await db.migrate();
await db.close();
console.log("HumanOS migrations applied");
