import { createPersistence } from "./persistence.js";
// This adapter is discovered by Flue's build and migrated at runtime startup.
export default createPersistence(process.env.DATABASE_URL ?? "");
