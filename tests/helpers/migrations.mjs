// All database migrations, in order, as one SQL script (what Supabase would have run)
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../../supabase/migrations/', import.meta.url);
export const MIGRATIONS = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(new URL(f, DIR), 'utf8')).join('\n');
