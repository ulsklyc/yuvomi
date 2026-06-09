/**
 * Modul: Setup-Script
 * Zweck: Erstmalige Einrichtung - ersten Admin-User anlegen.
 *        Wird einmalig nach dem ersten Start ausgeführt: `node setup.js`
 * Abhängigkeiten: server/db.js, bcrypt, dotenv
 */

import readline from 'node:readline';
import bcrypt from 'bcrypt';
import * as db from './server/db.js';
import os from 'node:os';

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function promptPassword(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let password = '';
    process.stdin.on('data', function handler(char) {
      char = char.toString();
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', handler);
        process.stdout.write('\n');
        resolve(password);
      } else if (char === '\u0003') {
        process.exit();
      } else if (char === '\u007f') {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        password += char;
        process.stdout.write('*');
      }
    });
  });
}

async function main() {
  console.log('\n=== Yuvomi Setup ===\n');

  // Prüfen ob bereits Admin vorhanden
  const existingAdmin = db.get()
    .prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1")
    .get();

  if (existingAdmin) {
    console.log('ℹ  An admin account already exists.\n');
    const proceed = await prompt('Create another admin anyway? (y/N): ');
    if (proceed.toLowerCase() !== 'y') {
      console.log('Setup cancelled.');
      rl.close();
      process.exit(0);
    }
  }

  console.log('Create admin account:\n');

  const username = (await prompt('Username: ')).trim();
  if (!username || username.length < 3) {
    console.error('Error: username must be at least 3 characters long.');
    process.exit(1);
  }

  const displayName = (await prompt('Display name (e.g. "Max Mustermann"): ')).trim();
  if (!displayName) {
    console.error('Error: display name must not be empty.');
    process.exit(1);
  }

  const password = await promptPassword('Password: ');
  if (password.length < 8) {
    console.error('Error: password must be at least 8 characters long.');
    process.exit(1);
  }

  const passwordConfirm = await promptPassword('Confirm password: ');
  if (password !== passwordConfirm) {
    console.error('Error: passwords do not match.');
    process.exit(1);
  }

  const avatarColors = ['#007AFF', '#34C759', '#FF9500', '#FF3B30', '#AF52DE', '#FF2D55'];
  const avatarColor = avatarColors[Math.floor(Math.random() * avatarColors.length)];

  console.log('\nCreating account …');

  const hash = await bcrypt.hash(password, 12);

  try {
    const result = db.get()
      .prepare(`
        INSERT INTO users (username, display_name, password_hash, avatar_color, role)
        VALUES (?, ?, ?, ?, 'admin')
      `)
      .run(username, displayName, hash, avatarColor);

    const port = process.env.PORT || 3000;
    const host = getLocalIP();

    console.log(`\n✅ Admin account created successfully!`);
    console.log(`${'─'.repeat(40)}`);
    console.log(`  Username:     ${username}`);
    console.log(`  Display name: ${displayName}`);
    console.log(`  Role:         Admin`);
    console.log(`${'─'.repeat(40)}`);
    console.log(`\n🌐 Yuvomi is available at:\n`);
    console.log(`   Local:     http://localhost:${port}`);
    if (host) {
      console.log(`   Network:   http://${host}:${port}`);
    }
    console.log(`\n   Sign in with your new account.\n`);
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      console.error(`\nError: username "${username}" is already taken.`);
    } else {
      console.error('\nCreation error:', err.message);
    }
    process.exit(1);
  }

  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
