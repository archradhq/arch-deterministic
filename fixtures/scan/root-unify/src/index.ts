import express from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/invoices', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM invoices');
  res.json(rows);
});

app.listen(3000);
