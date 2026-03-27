const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    const isSSL = process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: isSSL ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

async function initTables() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      safety_flags INTEGER DEFAULT 0,
      preferences JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS persona_cards (
      id TEXT PRIMARY KEY,
      scenario_id TEXT NOT NULL,
      card_data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_persona_scenario ON persona_cards(scenario_id);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      scenario_id TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      persona_card JSONB NOT NULL,
      engine_state JSONB,
      message_count INTEGER DEFAULT 0,
      confidence_score INTEGER,
      final_state TEXT,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_session_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      turn_score NUMERIC,
      score_breakdown JSONB,
      engine_snapshot JSONB,
      msg_order INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_message_session ON messages(session_id);

    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      session_id TEXT UNIQUE REFERENCES sessions(id),
      opener_score INTEGER,
      flow_score INTEGER,
      confidence_score INTEGER,
      timing_score INTEGER,
      calibration_score INTEGER,
      exit_score INTEGER,
      overall_score INTEGER,
      what_worked TEXT,
      what_to_improve TEXT,
      suggested_line TEXT,
      state_timeline JSONB,
      turn_by_turn JSONB,
      raw_feedback TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS streaks (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      streak_date DATE NOT NULL,
      sessions INTEGER DEFAULT 1,
      UNIQUE(user_id, streak_date)
    );
    CREATE INDEX IF NOT EXISTS idx_streak_user ON streaks(user_id);
  `);
  console.log('[DB] Tables initialized');
}

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

module.exports = { getPool, initTables, genId };
