import { loadConfig } from "./config.js";
import { ensureDataKeys, reencryptStaleCredentials } from "./crypto.js";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  const result = await migrate(pool);
  console.log(`migrations applied: ${result.applied.length === 0 ? "none (up to date)" : result.applied.join(", ")}`);
  if (config.dataKeys.length > 0) {
    const keys = await ensureDataKeys(pool, config.dataKeys);
    const moved = await reencryptStaleCredentials(pool, keys);
    console.log(`data keys ensured: ${keys.map((k) => k.id).join(", ")}; re-encrypted: ${moved}`);
  } else {
    console.warn("DATA_KEY unset: credential endpoints will answer 503 until configured");
  }
} finally {
  await pool.end();
}
