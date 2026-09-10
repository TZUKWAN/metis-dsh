const { app } = require('electron');
const Database = require('better-sqlite3');

app.whenReady().then(() => {
  const db = new Database(':memory:');
  try {
    const row = db.prepare('SELECT sqlite_version() AS version').get();
    process.stdout.write(`${JSON.stringify({
      electron: process.versions.electron,
      modules: process.versions.modules,
      sqlite: row.version,
    })}\n`);
  } finally {
    db.close();
    app.quit();
  }
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
