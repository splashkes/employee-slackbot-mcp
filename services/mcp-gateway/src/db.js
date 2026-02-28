import postgres from "postgres";
import { Logger } from "./logger.js";

const logger = new Logger(process.env.LOG_LEVEL || "info");

let sql_instance = null;

function create_db_client(connection_url) {
  if (!connection_url) {
    logger.warn("db_client_skipped", { reason: "no SUPABASE_DB_URL provided" });
    return null;
  }

  sql_instance = postgres(connection_url, {
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
    transform: {
      undefined: null
    }
  });

  logger.info("db_client_created", { max_connections: 5 });
  return sql_instance;
}

async function close_db_client() {
  if (sql_instance) {
    await sql_instance.end({ timeout: 5 });
    logger.info("db_client_closed");
  }
}

export { create_db_client, close_db_client };
