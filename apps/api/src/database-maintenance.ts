import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export async function backupDatabase(source: string, destination: string) {
  const sourcePath = resolve(source);
  const destinationPath = resolve(destination);
  if (sourcePath === destinationPath)
    throw new Error('Source and destination must be different files.');
  if (!existsSync(sourcePath))
    throw new Error(`Database not found: ${sourcePath}`);
  mkdirSync(dirname(destinationPath), { recursive: true });
  const database = new Database(sourcePath, { readonly: true });
  try {
    await database.backup(destinationPath);
  } finally {
    database.close();
  }
  verifyDatabase(destinationPath);
  return destinationPath;
}

export function verifyDatabase(path: string) {
  const database = new Database(resolve(path), { readonly: true });
  try {
    const rows = database.pragma('integrity_check') as Array<{
      integrity_check: string;
    }>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok')
      throw new Error('SQLite integrity check failed.');
  } finally {
    database.close();
  }
}

export async function restoreDatabase(backup: string, destination: string) {
  const backupPath = resolve(backup);
  const destinationPath = resolve(destination);
  if (backupPath === destinationPath)
    throw new Error('Backup and destination must be different files.');
  verifyDatabase(backupPath);
  const rollbackPath = `${destinationPath}.pre-restore-${Date.now()}`;
  if (existsSync(destinationPath)) renameSync(destinationPath, rollbackPath);
  try {
    await backupDatabase(backupPath, destinationPath);
  } catch (error) {
    if (existsSync(rollbackPath)) renameSync(rollbackPath, destinationPath);
    throw error;
  }
  return {
    destinationPath,
    rollbackPath: existsSync(rollbackPath) ? rollbackPath : undefined,
  };
}

async function main() {
  const [operation, source, destination, confirmation] = process.argv.slice(2);
  if (
    !source ||
    !destination ||
    !['backup', 'restore'].includes(operation ?? '')
  )
    throw new Error(
      'Usage: database-maintenance <backup|restore> <source.db> <destination.db> [--confirm]',
    );
  if (operation === 'restore' && confirmation !== '--confirm')
    throw new Error('Restore requires --confirm and the API must be stopped.');
  const result =
    operation === 'backup'
      ? await backupDatabase(source, destination)
      : await restoreDatabase(source, destination);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
