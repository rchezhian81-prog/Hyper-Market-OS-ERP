// A DATABASE_URL written for the compose network names the database by its service name, `db`. Run from the box itself
// — the smoke, a backup — that name does not exist; compose publishes the database on loopback at POSTGRES_PORT. The
// first administrator-run smoke (3 Oct 2026) died on `getaddrinfo ENOTFOUND db` for exactly this. Pure: no I/O.

export interface HostDatabaseUrl {
  readonly url: string;
  /** True when the compose service name was replaced by the box's loopback address. */
  readonly translated: boolean;
}

export function databaseUrlFromTheHost(url: string, env: Readonly<Record<string, string | undefined>>): HostDatabaseUrl {
  try {
    const u = new URL(url);
    if (u.hostname !== 'db') return { url, translated: false };
    u.hostname = '127.0.0.1';
    u.port = env['POSTGRES_PORT'] ?? '5432';
    return { url: u.toString(), translated: true };
  } catch {
    return { url, translated: false };
  }
}
