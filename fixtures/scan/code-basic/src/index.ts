import express from 'express';
import { Pool } from 'pg';
import rateLimit from 'express-rate-limit';

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
app.use(rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: 'draft-8', legacyHeaders: false }));

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
