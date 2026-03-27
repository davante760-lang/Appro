require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { getPool, initTables, genId } = require('./lib/db');
const { getClient } = require('./lib/claude');
const { SCENARIOS, SUGGESTED_OPENERS } = require('./lib/scenarios');
const { runPipeline } = require('./engine/pipeline');
const { initializeLatentVars } = require('./engine/latentVars');
const { generateRandomBand } = require('./engine/stateMachine');
const { isScenarioAllowed } = require('./engine/safety');
const { generateDebrief } = require('./engine/coachTip');
const DeepgramProxy = require('./lib/deepgram-proxy');
const { synthesize, VOICES } = require('./lib/elevenlabs');

// Deepgram proxy instance (created on first use)
let deepgramProxy = null;
function getDeepgram() {
  if (!deepgramProxy && process.env.DEEPGRAM_API_KEY) {
    deepgramProxy = new DeepgramProxy(process.env.DEEPGRAM_API_KEY);
  }
  return deepgramProxy;
}

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

// ── WebSocket: Voice Protocol ───────────────────────────────────
// Handles: mic audio streaming (STT), pipeline processing, TTS playback
// Also supports text fallback via { type: 'text.send' }

const voiceSessions = new Map(); // ws → { sessionId, transcriptBuffer }

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (data, isBinary) => {
    // Binary data = PCM audio from mic → forward to Deepgram
    if (isBinary) {
      const vsess = voiceSessions.get(ws);
      if (vsess?.sessionId) {
        const dg = getDeepgram();
        if (dg) dg.sendAudio(vsess.sessionId, Buffer.from(data));
      }
      return;
    }

    // JSON text message
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'voice.start') {
      // Start Deepgram STT session for this WebSocket
      const sessionId = msg.sessionId;
      if (!sessionId) return;

      voiceSessions.set(ws, { sessionId, transcriptBuffer: '', finalTranscript: '' });

      const dg = getDeepgram();
      if (!dg) {
        wsSend(ws, { type: 'error', message: 'Deepgram not configured' });
        return;
      }

      dg.createSession(
        sessionId,
        // onTranscript
        (t) => {
          const vsess = voiceSessions.get(ws);
          if (!vsess) return;

          if (t.type === 'utterance_end') {
            // Utterance ended — process the accumulated final transcript
            if (vsess.finalTranscript.trim()) {
              const text = vsess.finalTranscript.trim();
              vsess.finalTranscript = '';
              wsSend(ws, { type: 'transcript.final', text });
              processVoiceMessage(ws, sessionId, text);
            }
            return;
          }

          if (t.isFinal) {
            vsess.finalTranscript += ' ' + t.text;
            wsSend(ws, { type: 'transcript.interim', text: vsess.finalTranscript.trim(), isFinal: true });
          } else {
            wsSend(ws, { type: 'transcript.interim', text: (vsess.finalTranscript + ' ' + t.text).trim(), isFinal: false });
          }
        },
        // onError
        (err) => wsSend(ws, { type: 'error', message: 'STT error: ' + err.message }),
        // onReady
        () => wsSend(ws, { type: 'voice.ready' })
      );
    }

    else if (msg.type === 'voice.stop') {
      const vsess = voiceSessions.get(ws);
      if (vsess?.sessionId) {
        const dg = getDeepgram();
        if (dg) dg.closeSession(vsess.sessionId);
      }
      voiceSessions.delete(ws);
    }

    else if (msg.type === 'text.send') {
      // Text fallback — same as HTTP endpoint but via WebSocket
      if (msg.sessionId && msg.content) {
        processVoiceMessage(ws, msg.sessionId, msg.content);
      }
    }
  });

  ws.on('close', () => {
    const vsess = voiceSessions.get(ws);
    if (vsess?.sessionId) {
      const dg = getDeepgram();
      if (dg) dg.closeSession(vsess.sessionId);
    }
    voiceSessions.delete(ws);
  });
});

function wsSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Process a user message (from voice transcript or text) and send back response + audio
async function processVoiceMessage(ws, sessionId, content) {
  wsSend(ws, { type: 'pipeline.started' });

  try {
    const pool = getPool();

    // Fetch session
    const sessionResult = await pool.query(
      `SELECT * FROM sessions WHERE id = $1 AND status = 'active'`, [sessionId]
    );
    if (sessionResult.rows.length === 0) {
      wsSend(ws, { type: 'error', message: 'Session not found or ended' });
      return;
    }

    const session = sessionResult.rows[0];
    const persona = session.persona_card;
    const engineState = session.engine_state;
    const scenario = SCENARIOS[session.scenario_id];

    // Fetch messages
    const messagesResult = await pool.query(
      `SELECT role, content, turn_score as "turnScore", score_breakdown as "scoreBreakdown",
              engine_snapshot as "engineSnapshot", msg_order as "order"
       FROM messages WHERE session_id = $1 ORDER BY msg_order`, [sessionId]
    );
    const messages = messagesResult.rows;

    // Safety flags
    const userResult = await pool.query(`SELECT safety_flags FROM users WHERE id = $1`, [session.user_id]);
    const userSafetyFlags = userResult.rows[0]?.safety_flags || 0;

    // Run pipeline
    const { result, updatedEngineState } = await runPipeline(
      content, messages, engineState, persona, scenario, session.difficulty, userSafetyFlags
    );

    // Persist messages
    const userMsgOrder = messages.length;
    await pool.query(
      `INSERT INTO messages (id, session_id, role, content, turn_score, score_breakdown, engine_snapshot, msg_order)
       VALUES ($1, $2, 'user', $3, $4, $5, $6, $7)`,
      [genId('msg'), sessionId, content, result.turnScore, JSON.stringify(result.scoreBreakdown),
       JSON.stringify(result.engineSnapshot), userMsgOrder]
    );
    if (result.herResponse) {
      await pool.query(
        `INSERT INTO messages (id, session_id, role, content, msg_order)
         VALUES ($1, $2, 'assistant', $3, $4)`,
        [genId('msg'), sessionId, result.herResponse, userMsgOrder + 1]
      );
    }

    // Update session
    const newMessageCount = (session.message_count || 0) + 1;
    await pool.query(
      `UPDATE sessions SET engine_state = $1, message_count = $2, final_state = $3 WHERE id = $4`,
      [JSON.stringify(updatedEngineState), newMessageCount, updatedEngineState.currentState, sessionId]
    );
    if (result.safetyTriggered) {
      await pool.query(`UPDATE users SET safety_flags = safety_flags + 1 WHERE id = $1`, [session.user_id]);
    }
    if (updatedEngineState.currentState === 'EXITED') {
      await pool.query(`UPDATE sessions SET status = 'completed', completed_at = NOW() WHERE id = $1`, [sessionId]);
    }

    // Send text response immediately (so UI updates fast)
    wsSend(ws, {
      type: 'response.text',
      herResponse: result.herResponse,
      coachSuggestions: result.coachSuggestions,
      coachTip: result.coachTip,
      turnScore: result.turnScore,
      scoreBreakdown: result.scoreBreakdown,
      currentState: result.currentState,
      exchangeNumber: result.exchangeNumber,
      safetyTriggered: result.safetyTriggered || false,
    });

    // Generate TTS audio in parallel (her voice + coach voice)
    if (result.herResponse && process.env.ELEVENLABS_API_KEY) {
      try {
        const herAudio = await synthesize(result.herResponse, VOICES.persona_default);
        wsSend(ws, { type: 'response.audio', audio: herAudio.toString('base64') });
      } catch (e) {
        console.error('Her TTS error:', e.message);
      }

      // Coach audio — read out the suggestions
      if (result.coachSuggestions?.suggestions?.length > 0) {
        try {
          const coachText = result.coachSuggestions.coachNote + '... ' +
            'You could say: ' + result.coachSuggestions.suggestions[0];
          const coachAudio = await synthesize(coachText, VOICES.coach);
          wsSend(ws, { type: 'coach.audio', audio: coachAudio.toString('base64') });
        } catch (e) {
          console.error('Coach TTS error:', e.message);
        }
      }
    }

    if (updatedEngineState.currentState === 'EXITED') {
      wsSend(ws, { type: 'session.exited' });
    }
  } catch (error) {
    console.error('Voice pipeline error:', error);
    wsSend(ws, { type: 'error', message: 'Pipeline error: ' + error.message });
  }
}

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

    res.json({
      sessionId,
      scenario: { id: scenario.id, name: scenario.name, emoji: scenario.emoji, description: scenario.description },
      sceneDescription: scenario.sceneDescription,
      persona: { name: persona.name, age: persona.age, occupation: persona.occupation },
      suggestedOpeners: SUGGESTED_OPENERS[scenarioId] || [],
      difficulty,
      initialState,
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
