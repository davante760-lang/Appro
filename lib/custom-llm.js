// Custom LLM Handler — wraps runPipeline() in OpenAI-compatible SSE streaming format
// ElevenLabs Conversational AI calls this as its Custom LLM endpoint

const { getPool, genId } = require('./db');
const { SCENARIOS } = require('./scenarios');
const { runPipeline } = require('../engine/pipeline');

const DEV_USER_ID = 'dev-user-001';

// Track active sessions for coach push (sessionId → ws)
const coachSockets = new Map();

function registerCoachSocket(sessionId, ws) {
  coachSockets.set(sessionId, ws);
}

function unregisterCoachSocket(sessionId) {
  coachSockets.delete(sessionId);
}

function pushToCoachSocket(sessionId, data) {
  const ws = coachSockets.get(sessionId);
  if (ws && ws.readyState === 1) { // WebSocket.OPEN
    ws.send(JSON.stringify(data));
  }
}

// Extract sessionId from the request
// ElevenLabs sends it via custom_llm_extra_body or dynamic variables embedded in the system prompt
function extractSessionId(body) {
  // Option 1: extra body field
  if (body.session_id) return body.session_id;

  // Option 2: look for it in the system prompt (we embed it as SESSION_ID: xxx)
  const systemMsg = body.messages?.find(m => m.role === 'system');
  if (systemMsg) {
    const match = systemMsg.content.match(/SESSION_ID:\s*(\S+)/);
    if (match) return match[1];
  }

  return null;
}

// Extract the latest user message from ElevenLabs' messages array
function extractUserMessage(messages) {
  if (!messages?.length) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].content?.trim()) {
      return messages[i].content.trim();
    }
  }
  return null;
}

// Main handler for POST /v1/chat/completions
async function handleChatCompletion(req, res) {
  const body = req.body;

  // Debug: log what ElevenLabs sends us
  console.log('[Custom LLM] Received request:', JSON.stringify({
    model: body.model,
    session_id: body.session_id,
    hasMessages: body.messages?.length,
    systemPromptPreview: body.messages?.find(m => m.role === 'system')?.content?.substring(0, 200),
    lastUserMsg: body.messages?.filter(m => m.role === 'user')?.slice(-1)[0]?.content?.substring(0, 100),
    extraKeys: Object.keys(body).filter(k => !['model', 'messages', 'stream', 'temperature', 'max_tokens'].includes(k)),
  }));

  const sessionId = extractSessionId(body);
  const userMessage = extractUserMessage(body.messages);

  if (!sessionId) {
    return sendSSEError(res, 'No session_id found in request');
  }
  if (!userMessage) {
    return sendSSEError(res, 'No user message found');
  }

  // Set up SSE streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const pool = getPool();

    // Fetch session
    const sessionResult = await pool.query(
      `SELECT * FROM sessions WHERE id = $1 AND status = 'active'`, [sessionId]
    );
    if (sessionResult.rows.length === 0) {
      return sendSSEError(res, 'Session not found or ended');
    }

    const session = sessionResult.rows[0];
    const persona = session.persona_card;
    const engineState = session.engine_state;
    const scenario = SCENARIOS[session.scenario_id];

    if (!scenario) {
      return sendSSEError(res, 'Invalid scenario');
    }

    // Fetch message history from DB (not from ElevenLabs — ours is authoritative)
    const messagesResult = await pool.query(
      `SELECT role, content, turn_score as "turnScore", score_breakdown as "scoreBreakdown",
              engine_snapshot as "engineSnapshot", msg_order as "order"
       FROM messages WHERE session_id = $1 ORDER BY msg_order`, [sessionId]
    );
    const messages = messagesResult.rows;

    // Safety flags
    const userResult = await pool.query(`SELECT safety_flags FROM users WHERE id = $1`, [session.user_id]);
    const userSafetyFlags = userResult.rows[0]?.safety_flags || 0;

    // Run the full engine pipeline
    const { result, updatedEngineState } = await runPipeline(
      userMessage, messages, engineState, persona, scenario, session.difficulty, userSafetyFlags
    );

    // Persist to DB
    const userMsgOrder = messages.length;
    await pool.query(
      `INSERT INTO messages (id, session_id, role, content, turn_score, score_breakdown, engine_snapshot, msg_order)
       VALUES ($1, $2, 'user', $3, $4, $5, $6, $7)`,
      [genId('msg'), sessionId, userMessage, result.turnScore, JSON.stringify(result.scoreBreakdown),
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

    // Stream the response in OpenAI SSE format
    const responseText = result.herResponse || "I need to go. Bye.";
    const responseId = 'chatcmpl-' + Date.now();

    // Role chunk
    sendSSEChunk(res, {
      id: responseId,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });

    // Stream text word by word for natural TTS pacing
    const words = responseText.split(/(\s+)/);
    for (const word of words) {
      if (word) {
        sendSSEChunk(res, {
          id: responseId,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
        });
      }
    }

    // Done chunk
    sendSSEChunk(res, {
      id: responseId,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    res.write('data: [DONE]\n\n');
    res.end();

    // Push engine state + coach suggestions to browser via our WebSocket (non-blocking)
    pushToCoachSocket(sessionId, {
      type: 'engine.update',
      currentState: result.currentState,
      turnScore: result.turnScore,
      exchangeNumber: result.exchangeNumber,
      safetyTriggered: result.safetyTriggered || false,
      herResponse: result.herResponse,
    });

    // Generate coach suggestions in background (doesn't block the SSE response)
    if (result.coachSuggestions?.suggestions?.length) {
      pushToCoachSocket(sessionId, {
        type: 'coach.suggestions',
        suggestions: result.coachSuggestions.suggestions,
        coachNote: result.coachSuggestions.coachNote,
      });
    }

    if (updatedEngineState.currentState === 'EXITED') {
      pushToCoachSocket(sessionId, { type: 'session.exited' });
    }

  } catch (error) {
    console.error('[Custom LLM] Pipeline error:', error);
    sendSSEError(res, 'Pipeline error');
  }
}

function sendSSEChunk(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendSSEError(res, message) {
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
  }
  sendSSEChunk(res, {
    id: 'err-' + Date.now(),
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: message }, finish_reason: 'stop' }],
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

module.exports = {
  handleChatCompletion,
  registerCoachSocket,
  unregisterCoachSocket,
  pushToCoachSocket,
};
