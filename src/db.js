import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

let dbInstance = null;
let dbReady = null;

export const initDB = async () => {
  if (!dbReady) {
    dbReady = (async () => {
      const db = new PGlite({
        extensions: { vector }
      });
      if (db.waitReady) {
        await db.waitReady;
      }
      await db.exec(`
                CREATE EXTENSION IF NOT EXISTS vector;
                CREATE TABLE IF NOT EXISTS scraped_knowledge (
                    id SERIAL PRIMARY KEY,
                    content TEXT,
                    embedding vector(384)
                );
            `);
      dbInstance = db;
      return db;
    })();
  }
  return dbReady;
};

export const getDB = () => dbInstance;
