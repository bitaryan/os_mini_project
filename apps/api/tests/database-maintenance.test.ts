import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import {
  backupDatabase,
  restoreDatabase,
  verifyDatabase,
} from '../src/database-maintenance.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test('backup and restore preserve committed SQLite data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'printer-backup-'));
  directories.push(directory);
  const live = join(directory, 'live.db');
  const backup = join(directory, 'backup.db');
  const database = new Database(live);
  database.exec(
    "CREATE TABLE jobs (id TEXT PRIMARY KEY); INSERT INTO jobs VALUES ('job-1');",
  );
  database.close();

  await backupDatabase(live, backup);
  verifyDatabase(backup);
  const changed = new Database(live);
  changed.exec("INSERT INTO jobs VALUES ('job-2');");
  changed.close();

  const result = await restoreDatabase(backup, live);
  const restored = new Database(live, { readonly: true });
  expect(
    restored.prepare('SELECT id FROM jobs ORDER BY id').pluck().all(),
  ).toEqual(['job-1']);
  restored.close();
  expect(result.rollbackPath).toMatch(`${live}.pre-restore-`);
});
