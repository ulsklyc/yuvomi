/**
 * Modul: Prozesszustand fuer den Parallel-Runner
 * Zweck: Laeuft ein Prozess noch, und welche Mitglieder einer Prozessgruppe
 *        laufen noch?
 * Abhaengigkeiten: /proc (Linux), sonst `ps`
 *
 * EIN ZOMBIE IST BEENDET. `process.kill(pid, 0)` gelingt, solange der Eintrag
 * in der Prozesstabelle steht - bei einem getoeteten Waisen also, bis der
 * Init-Prozess ihn erntet. In Linux-Containern, deren PID 1 das nicht sofort
 * tut, bleibt ein beendeter Enkel als `Z` stehen, und eine Pruefung, die sein
 * Verschwinden verlangt, meldet eine laengst beendete Gruppe als lebendig
 * (Review auf #1229). Gelesen wird deshalb der Zustand: unter Linux Feld 3 von
 * `/proc/<pid>/stat`, sonst `ps -o stat=`.
 *
 * Die Leser sind als Parameter herausgezogen, damit der Test beide Zweige auf
 * jeder Plattform faehrt, ohne einen echten Zombie im jeweils anderen System.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const SYSTEM = {
  platform: process.platform,
  readFile: (file) => readFileSync(file, 'utf8'),
  listProc: () => readdirSync('/proc'),
  ps: (args) => execFileSync('ps', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
};

/**
 * `/proc/<pid>/stat` lesen: `pid (comm) S ppid pgrp ...`. Der Befehlsname darf
 * Leerzeichen und Klammern enthalten, gezaehlt wird deshalb ab der LETZTEN `)`.
 */
export function parseProcStat(text) {
  const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
  return { state: fields[0], pgid: Number(fields[2]) };
}

/**
 * @param {number} pid
 * @returns {'alive' | 'zombie' | 'gone'}
 */
export function processState(pid, io = {}) {
  const { platform, readFile, ps } = { ...SYSTEM, ...io };
  if (platform === 'linux') {
    let text;
    try { text = readFile(`/proc/${pid}/stat`); } catch { return 'gone'; }
    return parseProcStat(text).state === 'Z' ? 'zombie' : 'alive';
  }
  let out;
  // `ps -p` ohne Treffer endet mit Exit 1 - das ist "gone", kein Fehler.
  try { out = ps(['-o', 'stat=', '-p', String(pid)]).trim(); } catch { return 'gone'; }
  if (!out) return 'gone';
  return out.startsWith('Z') ? 'zombie' : 'alive';
}

/** Laeuft `pid` noch? Ein Zombie laeuft nicht. */
export const isRunning = (pid, io) => processState(pid, io) === 'alive';

/**
 * Die PIDs aller Prozesse in den Gruppen `pgids`, die noch laufen (Zombies
 * nicht mitgezaehlt). Ohne `ps` ausserhalb von Linux ist die Liste leer - der
 * Runner wartet dann nicht, statt ewig zu warten.
 */
export function runningGroupMembers(pgids, io = {}) {
  const { platform, readFile, listProc, ps } = { ...SYSTEM, ...io };
  const wanted = new Set(pgids);
  const members = [];
  if (platform === 'linux') {
    for (const name of listProc()) {
      if (!/^\d+$/.test(name)) continue;
      let stat;
      try { stat = parseProcStat(readFile(`/proc/${name}/stat`)); } catch { continue; }
      if (wanted.has(stat.pgid) && stat.state !== 'Z') members.push(Number(name));
    }
    return members;
  }
  let out = '';
  try { out = ps(['-A', '-o', 'pid=,pgid=,stat=']); } catch { return members; }
  for (const line of out.split('\n')) {
    const [pid, pgid, stat = ''] = line.trim().split(/\s+/);
    if (pid && wanted.has(Number(pgid)) && !stat.startsWith('Z')) members.push(Number(pid));
  }
  return members;
}
