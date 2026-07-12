import express from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function requireAuth(req: any, res: any, next: any) {
  if (!req.headers.authorization) return res.status(401).end();
  next();
}

app.use(requireAuth);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/users', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM users');
  res.json(rows);
});

app.listen(3000);
