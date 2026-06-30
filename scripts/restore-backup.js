#!/usr/bin/env node

/**
 * Restore an Yuvomi database backup from the CLI.
 *
 * Usage:
 *   node --import dotenv/config scripts/restore-backup.js /path/to/yuvomi-backup.db
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import 'dotenv/config';
import { getPath, restoreFromFile } from '../server/db.js';

const backupPath = process.argv[2];

if (!backupPath) {
  console.error('Usage: node --import dotenv/config scripts/restore-backup.js /path/to/yuvomi-backup.db');
  process.exit(1);
}

const resolved = path.resolve(backupPath);

try {
  await fs.access(resolved);
  const result = await restoreFromFile(resolved);
  console.log(`Restored ${resolved} into ${getPath()}. Schema v${result.schemaVersion}.`);
  if (result.rollbackPath) {
    console.log(`Previous database copy saved at ${result.rollbackPath}.`);
  }
  process.exit(0);
} catch (err) {
  console.error(`Restore failed: ${err?.message || err}`);
  process.exit(1);
}
