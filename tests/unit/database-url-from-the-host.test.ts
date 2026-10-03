import { describe, it, expect } from 'vitest';
import { databaseUrlFromTheHost } from '../../scripts/lib/database-url-from-the-host';

// The settings file is written for the containers, where the database is `db`. A tool run on the box itself must reach
// the same database on loopback — and must leave every other address exactly as written.
describe('a compose database address, read from the box itself', () => {
  it('turns the service name into loopback at POSTGRES_PORT, keeping user, password and database', () => {
    const r = databaseUrlFromTheHost('postgres://sre_app:s3cret@db:5432/sre_pilot', { POSTGRES_PORT: '5433' });
    expect(r).toEqual({ url: 'postgres://sre_app:s3cret@127.0.0.1:5433/sre_pilot', translated: true });
  });

  it('defaults the port to 5432 when the settings name none', () => {
    expect(databaseUrlFromTheHost('postgresql://u:p@db:5432/d', {}).url).toBe('postgresql://u:p@127.0.0.1:5432/d');
  });

  it('leaves a loopback, a domain or a nonsense address untouched', () => {
    for (const url of ['postgres://u:p@127.0.0.1:5432/d', 'postgres://u:p@db.internal.example:5432/d', 'not a url']) {
      expect(databaseUrlFromTheHost(url, { POSTGRES_PORT: '9' })).toEqual({ url, translated: false });
    }
  });
});
