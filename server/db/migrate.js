const fs = require('fs');
const path = require('path');
const postgres = require('./postgres');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function listMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(file => file.endsWith('.sql'))
    .sort();
}

async function ensureMigrationTable(client) {
  await client.query(`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function getAppliedVersions(client) {
  const result = await client.query('select version from schema_migrations');
  return new Set(result.rows.map(row => row.version));
}

async function runMigrations({ logger = console } = {}) {
  if (!postgres.isConfigured()) {
    return { skipped: true, reason: 'database-url-missing', applied: [] };
  }

  return postgres.withClient(async client => {
    await ensureMigrationTable(client);
    const appliedVersions = await getAppliedVersions(client);
    const applied = [];

    for (const file of listMigrationFiles()) {
      if (appliedVersions.has(file)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query(
          'insert into schema_migrations (version) values ($1) on conflict (version) do nothing',
          [file]
        );
        await client.query('commit');
        applied.push(file);
        logger.log(`[DB] Applied migration ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }

    return { ok: true, applied };
  });
}

if (require.main === module) {
  runMigrations()
    .then(result => {
      if (result.skipped) {
        console.log(`[DB] Migration skipped: ${result.reason}`);
      } else if (result.applied.length === 0) {
        console.log('[DB] Migrations already up to date');
      }
    })
    .finally(() => postgres.closePool())
    .catch(err => {
      console.error(`[DB] Migration failed: ${err.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  runMigrations,
};
