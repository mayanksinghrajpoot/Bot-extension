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
                CREATE TABLE IF NOT EXISTS pre_processed_entities (
                    id SERIAL PRIMARY KEY,
                    raw_extracted_text TEXT,
                    embedding vector(384)
                );
                CREATE INDEX IF NOT EXISTS scraped_knowledge_embedding_idx 
                    ON scraped_knowledge USING hnsw (embedding vector_cosine_ops);
                CREATE INDEX IF NOT EXISTS pre_processed_entities_embedding_idx 
                    ON pre_processed_entities USING hnsw (embedding vector_cosine_ops);
            `);
      dbInstance = db;
      return db;
    })();
  }
  return dbReady;
};

export const getDB = () => dbInstance;
