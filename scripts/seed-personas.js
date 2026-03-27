require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { getPool, initTables } = require('../lib/db');

const PERSONA_DIR = path.join(__dirname, '..', 'data', 'personas');

const SCENARIOS = ['coffee', 'bar', 'gym', 'park', 'bookstore', 'grocery'];

async function seedPersonas() {
  await initTables();
  const pool = getPool();

  let inserted = 0;
  let skipped = 0;

  for (const scenario of SCENARIOS) {
    const filePath = path.join(PERSONA_DIR, `${scenario}.json`);
    const personas = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    for (const persona of personas) {
      const id = `persona_${scenario}_${persona.name.toLowerCase()}`;

      const result = await pool.query(
        `INSERT INTO persona_cards (id, scenario_id, card_data)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [id, scenario, JSON.stringify(persona)]
      );

      if (result.rowCount > 0) {
        inserted++;
        console.log(`  + ${id}`);
      } else {
        skipped++;
        console.log(`  ~ ${id} (already exists)`);
      }
    }
  }

  console.log(`\n[seed-personas] Done: ${inserted} inserted, ${skipped} skipped`);
  await pool.end();
}

seedPersonas().catch((err) => {
  console.error('[seed-personas] Error:', err);
  process.exit(1);
});
