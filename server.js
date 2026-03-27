require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const { getPool, initTables, genId } = require('./lib/db');
const { getClient } = require('./lib/claude');
const { SCENARIOS, SUGGESTED_OPENERS } = require('./lib/scenarios');
const { runPipeline } = require('./engine/pipeline');
const { initializeLatentVars } = require('./engine/latentVars');
const { generateRandomBand } = require('./engine/stateMachine');
const { isScenarioAllowed } = require('./engine/safety');
const { generateDebrief } = require('./engine/coachTip');
const { handleChatCompletion, registerCoachSocket, unregisterCoachSocket } = require('./lib/custom-llm');
const { buildSystemPrompt } = require('./engine/contextAssembly');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DEV_USER_ID = 'dev-user-001';

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  },
}));

// ── Custom LLM endpoint for ElevenLabs Conversational AI ────────
// ElevenLabs calls this as its "brain" — we run the full pipeline and stream back
app.post('/v1/chat/completions', handleChatCompletion);

// ── API: Signed URL for ElevenLabs agent (browser requests this) ─
app.post('/api/elevenlabs/signed-url', async (req, res) => {
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!agentId) {
    return res.status(500).json({ error: 'ELEVENLABS_AGENT_ID not configured' });
  }
  // For public agents, just return the agent ID — browser connects directly
  // For private agents, you'd call ElevenLabs API to get a signed URL here
  res.json({ agentId });
});

// ── WebSocket: Coach Push + UI State Updates ────────────────────
// ElevenLabs handles voice. Our WebSocket pushes coach suggestions + state updates.

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'session.bind') {
      // Browser tells us which session to push coach data for
      ws.sessionId = msg.sessionId;
      registerCoachSocket(msg.sessionId, ws);
      console.log('[WS] Coach socket bound to session', msg.sessionId);
    }
  });

  ws.on('close', () => {
    if (ws.sessionId) {
      unregisterCoachSocket(ws.sessionId);
    }
  });
});

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);
wss.on('close', () => clearInterval(pingInterval));

// ── Ensure dev user exists ──────────────────────────────────────
async function ensureDevUser() {
  const pool = getPool();
  await pool.query(
    `INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [DEV_USER_ID, 'dev@approach.app']
  );
}

// ── API: Get scenarios ──────────────────────────────────────────
app.get('/api/scenarios', (_req, res) => {
  const list = Object.values(SCENARIOS).map((s) => ({
    id: s.id, name: s.name, emoji: s.emoji, description: s.description,
  }));
  res.json({ scenarios: list });
});

// ── API: Create session ─────────────────────────────────────────
app.post('/api/sessions', async (req, res) => {
  try {
    const { scenarioId, difficulty } = req.body;

    if (!SCENARIOS[scenarioId]) {
      return res.status(400).json({ error: 'Invalid scenario' });
    }
    if (!['warm', 'neutral', 'guarded'].includes(difficulty)) {
      return res.status(400).json({ error: 'Invalid difficulty' });
    }
    if (!isScenarioAllowed(scenarioId)) {
      return res.status(400).json({ error: 'Restricted scenario' });
    }

    const pool = getPool();
    const scenario = SCENARIOS[scenarioId];

    // Select random persona from DB
    const personaResult = await pool.query(
      `SELECT card_data FROM persona_cards WHERE scenario_id = $1 ORDER BY RANDOM() LIMIT 1`,
      [scenarioId]
    );

    if (personaResult.rows.length === 0) {
      return res.status(500).json({ error: 'No personas found for this scenario. Run: npm run seed' });
    }

    const persona = personaResult.rows[0].card_data;

    // Initialize engine state
    const latentVars = initializeLatentVars(difficulty, scenario, persona);
    const sessionSeed = Date.now();
    const randomBand = generateRandomBand(sessionSeed);

    const initialState = difficulty === 'guarded' ? 'GUARDED' : 'NEUTRAL';

    const engineState = {
      currentState: initialState,
      latentVars,
      cumulativeScore: 0,
      exchangeNumber: 1,
      consecutiveWeakTurns: 0,
      consecutiveStrongTurns: 0,
      ignoredExitCues: 0,
      chemistrySpikeUsed: false,
      randomBand,
      recentTurnScores: [],
    };

    const sessionId = genId('ses');

    await pool.query(
      `INSERT INTO sessions (id, user_id, scenario_id, difficulty, persona_card, engine_state, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
      [sessionId, DEV_USER_ID, scenarioId, difficulty, JSON.stringify(persona), JSON.stringify(engineState)]
    );

    // Build system prompt for ElevenLabs Custom LLM
    const systemPrompt = buildSystemPrompt(persona, initialState, latentVars, scenario, 1)
      + `\n\nSESSION_ID: ${sessionId}`;

    res.json({
      sessionId,
      scenario: { id: scenario.id, name: scenario.name, emoji: scenario.emoji, description: scenario.description },
      sceneDescription: scenario.sceneDescription,
      persona: { name: persona.name, age: persona.age, occupation: persona.occupation },
      suggestedOpeners: SUGGESTED_OPENERS[scenarioId] || [],
      difficulty,
      initialState,
      systemPrompt,
    });
  } catch (error) {
    console.error('Create session error:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// ── API: Send message ───────────────────────────────────────────
app.post('/api/sessions/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content required' });
    }

    const pool = getPool();

    // Fetch session
    const sessionResult = await pool.query(
      `SELECT * FROM sessions WHERE id = $1 AND status = 'active'`,
      [id]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found or already ended' });
    }

    const session = sessionResult.rows[0];
    const persona = session.persona_card;
    const engineState = session.engine_state;
    const scenario = SCENARIOS[session.scenario_id];

    // Fetch existing messages
    const messagesResult = await pool.query(
      `SELECT role, content, turn_score as "turnScore", score_breakdown as "scoreBreakdown",
              engine_snapshot as "engineSnapshot", msg_order as "order"
       FROM messages WHERE session_id = $1 ORDER BY msg_order`,
      [id]
    );
    const messages = messagesResult.rows;

    // Fetch user safety flags
    const userResult = await pool.query(`SELECT safety_flags FROM users WHERE id = $1`, [session.user_id]);
    const userSafetyFlags = userResult.rows[0]?.safety_flags || 0;

    // Run pipeline
    const { result, updatedEngineState } = await runPipeline(
      content.trim(), messages, engineState, persona, scenario, session.difficulty, userSafetyFlags
    );

    // Insert user message
    const userMsgId = genId('msg');
    const userMsgOrder = messages.length;
    await pool.query(
      `INSERT INTO messages (id, session_id, role, content, turn_score, score_breakdown, engine_snapshot, msg_order)
       VALUES ($1, $2, 'user', $3, $4, $5, $6, $7)`,
      [userMsgId, id, content.trim(), result.turnScore, JSON.stringify(result.scoreBreakdown),
       JSON.stringify(result.engineSnapshot), userMsgOrder]
    );

    // Insert assistant message (her response)
    if (result.herResponse) {
      const asstMsgId = genId('msg');
      await pool.query(
        `INSERT INTO messages (id, session_id, role, content, msg_order)
         VALUES ($1, $2, 'assistant', $3, $4)`,
        [asstMsgId, id, result.herResponse, userMsgOrder + 1]
      );
    }

    // Insert coach tip
    if (result.coachTip && result.coachTip.text) {
      const coachMsgId = genId('msg');
      await pool.query(
        `INSERT INTO messages (id, session_id, role, content, msg_order)
         VALUES ($1, $2, 'coach', $3, $4)`,
        [coachMsgId, id, result.coachTip.text, userMsgOrder + 2]
      );
    }

    // Update session engine state + message count
    const newMessageCount = (session.message_count || 0) + 1;
    await pool.query(
      `UPDATE sessions SET engine_state = $1, message_count = $2, final_state = $3 WHERE id = $4`,
      [JSON.stringify(updatedEngineState), newMessageCount, updatedEngineState.currentState, id]
    );

    // If safety triggered, increment user safety flags
    if (result.safetyTriggered) {
      await pool.query(`UPDATE users SET safety_flags = safety_flags + 1 WHERE id = $1`, [session.user_id]);
    }

    // Auto-end session if EXITED
    if (updatedEngineState.currentState === 'EXITED') {
      await pool.query(
        `UPDATE sessions SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [id]
      );
    }

    res.json({
      herResponse: result.herResponse,
      coachTip: result.coachTip,
      coachSuggestions: result.coachSuggestions,
      turnScore: result.turnScore,
      scoreBreakdown: result.scoreBreakdown,
      currentState: result.currentState,
      latentVars: updatedEngineState.latentVars,
      exchangeNumber: result.exchangeNumber,
      safetyTriggered: result.safetyTriggered || false,
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to process message' });
  }
});

// ── API: End session ────────────────────────────────────────────
app.post('/api/sessions/:id/end', async (req, res) => {
  try {
    const { id } = req.params;
    const { confidenceScore } = req.body;
    const pool = getPool();

    const sessionResult = await pool.query(`SELECT * FROM sessions WHERE id = $1`, [id]);
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = sessionResult.rows[0];
    const persona = session.persona_card;
    const scenario = SCENARIOS[session.scenario_id];

    // Fetch messages
    const messagesResult = await pool.query(
      `SELECT role, content, turn_score as "turnScore", score_breakdown as "scoreBreakdown",
              engine_snapshot as "engineSnapshot", msg_order as "order"
       FROM messages WHERE session_id = $1 ORDER BY msg_order`,
      [id]
    );
    const messages = messagesResult.rows;

    // Collect engine snapshots from user messages
    const snapshots = messages
      .filter((m) => m.role === 'user' && m.engineSnapshot)
      .map((m) => m.engineSnapshot);

    // Generate debrief
    const anthropic = getClient();
    const feedback = await generateDebrief(
      anthropic, messages, persona, scenario, session.difficulty, snapshots
    );

    // Insert feedback
    const feedbackId = genId('fb');
    await pool.query(
      `INSERT INTO feedback (id, session_id, opener_score, flow_score, confidence_score, timing_score,
         calibration_score, exit_score, overall_score, what_worked, what_to_improve, suggested_line,
         state_timeline, turn_by_turn)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (session_id) DO NOTHING`,
      [feedbackId, id, feedback.openerScore, feedback.flowScore,
       confidenceScore || feedback.confidenceScore, feedback.timingScore,
       feedback.calibrationScore, feedback.exitScore, feedback.overallScore,
       feedback.whatWorked, feedback.whatToImprove, feedback.suggestedLine,
       JSON.stringify(feedback.stateTimeline), JSON.stringify(feedback.turnByTurn)]
    );

    // Update session status
    await pool.query(
      `UPDATE sessions SET status = 'completed', completed_at = NOW(),
         confidence_score = $1, final_state = $2 WHERE id = $3`,
      [confidenceScore || feedback.confidenceScore, session.engine_state.currentState, id]
    );

    // Upsert streak
    const streakId = genId('str');
    await pool.query(
      `INSERT INTO streaks (id, user_id, streak_date, sessions)
       VALUES ($1, $2, CURRENT_DATE, 1)
       ON CONFLICT (user_id, streak_date) DO UPDATE SET sessions = streaks.sessions + 1`,
      [streakId, session.user_id]
    );

    res.json({ feedback });
  } catch (error) {
    console.error('End session error:', error);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

// ── API: Session history ────────────────────────────────────────
app.get('/api/sessions', async (_req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT s.id, s.scenario_id, s.difficulty, s.status, s.message_count,
              s.confidence_score, s.final_state, s.created_at, s.completed_at,
              (s.persona_card->>'name') as persona_name,
              f.overall_score
       FROM sessions s
       LEFT JOIN feedback f ON f.session_id = s.id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC
       LIMIT 20`,
      [DEV_USER_ID]
    );

    const sessions = result.rows.map((r) => ({
      id: r.id,
      scenarioId: r.scenario_id,
      scenario: SCENARIOS[r.scenario_id] ? {
        name: SCENARIOS[r.scenario_id].name,
        emoji: SCENARIOS[r.scenario_id].emoji,
      } : null,
      difficulty: r.difficulty,
      status: r.status,
      messageCount: r.message_count,
      confidenceScore: r.confidence_score,
      finalState: r.final_state,
      personaName: r.persona_name,
      overallScore: r.overall_score,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    }));

    res.json({ sessions });
  } catch (error) {
    console.error('Session history error:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// ── API: Get single session with messages ───────────────────────
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const pool = getPool();
    const sessionResult = await pool.query(`SELECT * FROM sessions WHERE id = $1`, [req.params.id]);
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = sessionResult.rows[0];
    const messagesResult = await pool.query(
      `SELECT role, content, turn_score, score_breakdown, engine_snapshot, msg_order
       FROM messages WHERE session_id = $1 ORDER BY msg_order`,
      [req.params.id]
    );

    const feedbackResult = await pool.query(
      `SELECT * FROM feedback WHERE session_id = $1`,
      [req.params.id]
    );

    res.json({
      session: {
        id: session.id,
        scenarioId: session.scenario_id,
        difficulty: session.difficulty,
        status: session.status,
        persona: session.persona_card,
        engineState: session.engine_state,
        messageCount: session.message_count,
        createdAt: session.created_at,
      },
      messages: messagesResult.rows,
      feedback: feedbackResult.rows[0] || null,
    });
  } catch (error) {
    console.error('Get session error:', error);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// ── Start Server ────────────────────────────────────────────────
async function start() {
  try {
    await initTables();
    await ensureDevUser();
    server.listen(PORT, () => {
      console.log(`[APPROACH] Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

start();
