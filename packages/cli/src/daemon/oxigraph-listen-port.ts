/**
 * Verify a child process owns a TCP listen socket on a port.
 *
 * HTTP 200 on loopback alone is not enough — another local SPARQL service
 * can answer while our `oxigraph serve` child died on EADDRINUSE. We try
 * platform-specific probes in order and require a match on `child.pid`.
 *
 * `lsof` is preferred on Unix but often missing in minimal Linux/container
 * images; Linux fallbacks use `ss`, `fuser`, then `/proc` inode matching.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Hex port token as it appears in `/proc/net/tcp` (little-endian). */
export function procNetLocalPortHex(port: number): string {
  const hi = (port >> 8) & 0xff;
  const lo = port & 0xff;
  return ((lo << 8) | hi).toString(16).toUpperCase().padStart(4, '0');
}

async function lsofShowsPidListening(pid: number, port: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'],
      { timeout: 2_000 },
    );
    return stdout.split('\n').some((line) => {
      const parts = line.trim().split(/\s+/);
      return parts.length >= 2 && Number(parts[1]) === pid;
    });
  } catch {
    return false;
  }
}

async function ssShowsPidListening(pid: number, port: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'ss',
      ['-ltnH', `sport = :${port}`],
      { timeout: 2_000 },
    );
    for (const line of stdout.split('\n')) {
      const m = line.match(/pid=(\d+)/);
      if (m && Number(m[1]) === pid) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function fuserShowsPidOnPort(pid: number, port: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('fuser', [`${port}/tcp`], {
      timeout: 2_000,
    });
    return stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .some((tok) => Number(tok) === pid);
  } catch {
    return false;
  }
}

async function procfsShowsPidListening(pid: number, port: number): Promise<boolean> {
  try {
    const portHex = procNetLocalPortHex(port);
    const tcp = await readFile('/proc/net/tcp', 'utf8');
    let listenInode: string | null = null;
    for (const line of tcp.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const local = cols[1];
      const state = cols[3];
      if (state !== '0A') continue;
      const [, portField] = local.split(':');
      if (portField?.toUpperCase() === portHex) {
        listenInode = cols[9];
        break;
      }
    }
    if (!listenInode) return false;

    const fdDir = `/proc/${pid}/fd`;
    const fds = await readdir(fdDir);
    const socketNeedle = `socket:[${listenInode}]`;
    for (const fd of fds) {
      try {
        const target = await readlink(`${fdDir}/${fd}`);
        if (target.includes(socketNeedle)) return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function windowsChildOwnsPort(pid: number, port: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { timeout: 3_000 });
    const suffix = `:${port}`;
    for (const line of stdout.split('\n')) {
      if (!line.includes('LISTENING') || !line.includes(suffix)) continue;
      const parts = line.trim().split(/\s+/);
      const rowPid = Number(parts[parts.length - 1]);
      if (rowPid === pid) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Return true when `child` is alive and owns the TCP listener on `port`.
 * For non-loopback hosts we only require the child to be alive (tests).
 */
export async function childOwnsListenPort(
  child: ChildProcess,
  port: number,
  host: string,
): Promise<boolean> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return false;
  }
  if (host !== '127.0.0.1' && host !== 'localhost') return true;

  const pid = child.pid;

  if (process.platform === 'win32') {
    return windowsChildOwnsPort(pid, port);
  }

  if (await lsofShowsPidListening(pid, port)) return true;

  if (process.platform === 'linux') {
    if (await ssShowsPidListening(pid, port)) return true;
    if (await fuserShowsPidOnPort(pid, port)) return true;
    if (await procfsShowsPidListening(pid, port)) return true;
  }

  return false;
}
