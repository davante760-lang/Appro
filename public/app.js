// ═══ APPROACH — Voice Chat Client (ElevenLabs Conversational AI) ═══

let currentSession = null;
let selectedScenario = null;
let selectedDifficulty = null;

// ElevenLabs conversation (raw WebSocket)
let elWs = null;
let isConversationActive = false;
let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;

// Our WebSocket for coach push + state updates
let coachWs = null;

// ── View Switching ──────────────────────────────────────────────

function switchView(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  if (view === 'home') loadHistory();
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

// ── Home Screen ─────────────────────────────────────────────────

async function initHome() {
  try {
    const resp = await fetch('/api/scenarios');
    const data = await resp.json();
    renderScenarioGrid(data.scenarios);
  } catch (e) { console.error('Failed to load scenarios:', e); }

  document.querySelectorAll('.difficulty-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.difficulty-chip').forEach((c) => c.classList.remove('selected'));
      chip.classList.add('selected');
      selectedDifficulty = chip.dataset.difficulty;
      updateStartButton();
    });
  });

  document.getElementById('start-btn').addEventListener('click', startSession);
  loadHistory();
}

function renderScenarioGrid(scenarios) {
  const grid = document.getElementById('scenario-grid');
  grid.innerHTML = '';
  scenarios.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'scenario-card';
    card.dataset.id = s.id;
    card.innerHTML = `
      <span class="scenario-emoji">${s.emoji}</span>
      <span class="scenario-name">${escapeHtml(s.name)}</span>
      <span class="scenario-desc">${escapeHtml(s.description)}</span>
    `;
    card.addEventListener('click', () => {
      document.querySelectorAll('.scenario-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedScenario = s.id;
      updateStartButton();
    });
    grid.appendChild(card);
  });
}

function updateStartButton() {
  document.getElementById('start-btn').disabled = !(selectedScenario && selectedDifficulty);
}

async function loadHistory() {
  try {
    const resp = await fetch('/api/sessions');
    const data = await resp.json();
    const list = document.getElementById('history-list');
    if (!data.sessions?.length) {
      list.innerHTML = '<p class="empty-state">No sessions yet. Start your first one above.</p>';
      return;
    }
    list.innerHTML = '';
    data.sessions.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      const sc = s.overallScore >= 7 ? 'var(--warm)' : s.overallScore >= 4 ? 'var(--neutral-color)' : 'var(--guarded)';
      item.innerHTML = `
        <span class="history-emoji">${s.scenario ? s.scenario.emoji : ''}</span>
        <div class="history-info">
          <div class="history-name">${s.scenario ? escapeHtml(s.scenario.name) : s.scenarioId} — ${escapeHtml(s.personaName || 'Unknown')}</div>
          <div class="history-meta">${s.difficulty} · ${s.messageCount || 0} msgs · ${timeAgo(s.createdAt)}</div>
        </div>
        ${s.overallScore ? `<span class="history-score" style="color:${sc}">${s.overallScore}/10</span>` : `<span class="history-score" style="color:var(--text-muted)">${escapeHtml(s.status || 'active')}</span>`}
      `;
      list.appendChild(item);
    });
  } catch (e) { console.error('Failed to load history:', e); }
}

// ── Start Session ───────────────────────────────────────────────

async function startSession() {
  if (!selectedScenario || !selectedDifficulty) return;
  const btn = document.getElementById('start-btn');
  btn.disabled = true;
  btn.textContent = 'Starting...';

  try {
    const resp = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenarioId: selectedScenario, difficulty: selectedDifficulty }),
    });
    const data = await resp.json();
    if (!resp.ok) { alert(data.error || 'Failed to start'); return; }
    currentSession = data;
    openVoiceChat(data);
  } catch (e) {
    console.error('Start error:', e);
    alert('Failed to start session');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Start Session';
  }
}

// ── Voice Chat (ElevenLabs Conversational AI) ───────────────────

function openVoiceChat(session) {
  // Set header
  document.getElementById('chat-scenario-emoji').textContent = session.scenario.emoji;
  document.getElementById('chat-scenario-name').textContent = session.scenario.name;
  updateStateBadge(session.initialState || 'NEUTRAL');

  // Scene setter
  document.getElementById('scene-setter').textContent = session.sceneDescription;

  // Reset UI
  setVoiceStatus('Tap mic to start conversation');
  document.getElementById('her-response-area').classList.add('hidden');
  document.getElementById('live-transcript').classList.add('hidden');
  document.getElementById('coach-panel').classList.add('hidden');
  document.getElementById('mic-btn').classList.remove('recording');
  document.getElementById('mic-btn').disabled = false;

  // Openers
  const openersPanel = document.getElementById('openers-panel');
  const openersList = document.getElementById('openers-list');
  openersList.innerHTML = '';
  if (session.suggestedOpeners?.length) {
    openersPanel.classList.remove('hidden');
    session.suggestedOpeners.forEach((opener) => {
      const chip = document.createElement('button');
      chip.className = 'opener-chip';
      chip.textContent = opener;
      openersList.appendChild(chip);
    });
  }

  // Connect our WebSocket for coach push
  connectCoachWebSocket(session.sessionId);

  switchView('chat');
}

// ── Coach WebSocket (our server → browser for suggestions + state) ──

function connectCoachWebSocket(sessionId) {
  if (coachWs) { coachWs.close(); coachWs = null; }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  coachWs = new WebSocket(`${protocol}//${location.host}`);

  coachWs.onopen = () => {
    console.log('[Coach WS] Connected');
    coachWs.send(JSON.stringify({ type: 'session.bind', sessionId }));
  };

  coachWs.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    switch (msg.type) {
      case 'engine.update':
        updateStateBadge(msg.currentState);
        if (msg.herResponse) showHerResponse(msg.herResponse);
        // Hide openers after first exchange
        document.getElementById('openers-panel').classList.add('hidden');
        break;

      case 'coach.suggestions':
        showCoachSuggestions(msg);
        break;

      case 'session.exited':
        setVoiceStatus('Session ended');
        document.getElementById('mic-btn').disabled = true;
        stopElevenLabsConversation();
        break;
    }
  };

  coachWs.onclose = () => console.log('[Coach WS] Disconnected');
}

// ── ElevenLabs Conversation (Raw WebSocket) ─────────────────────

async function startElevenLabsConversation() {
  if (isConversationActive) {
    stopElevenLabsConversation();
    return;
  }

  try {
    setVoiceStatus('Connecting...', 'processing');
    document.getElementById('mic-btn').disabled = true;

    // Get agent ID from server
    const agentResp = await fetch('/api/elevenlabs/signed-url', { method: 'POST' });
    const agentData = await agentResp.json();

    if (!agentData.agentId) {
      setVoiceStatus('ElevenLabs agent not configured — check ELEVENLABS_AGENT_ID');
      document.getElementById('mic-btn').disabled = false;
      return;
    }

    // Request mic access
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    // Connect to ElevenLabs Conversational AI WebSocket
    const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentData.agentId}`;
    elWs = new WebSocket(wsUrl);

    elWs.onopen = () => {
      console.log('[ElevenLabs] WebSocket connected');

      // Send conversation initiation data with our system prompt + session ID
      elWs.send(JSON.stringify({
        type: 'conversation_initiation_client_data',
        conversation_initiation_client_data: {
          conversation_config_override: {
            agent: {
              prompt: { prompt: currentSession.systemPrompt },
              first_message: null,
            },
          },
          dynamic_variables: {
            session_id: currentSession.sessionId,
          },
        },
      }));

      // Start capturing and sending audio
      startMicCapture();

      isConversationActive = true;
      document.getElementById('mic-btn').disabled = false;
      document.getElementById('mic-btn').classList.add('recording');
      document.getElementById('mic-pulse').classList.remove('hidden');
      setVoiceStatus('Listening — speak now', 'listening');
      document.getElementById('openers-panel').classList.add('hidden');
    };

    elWs.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      // Debug: log every message type and its keys
      if (msg.type !== 'audio') {
        console.log('[ElevenLabs] Message:', msg.type, JSON.stringify(msg).substring(0, 300));
      }

      switch (msg.type) {
        case 'audio':
          // Try multiple possible field paths for the audio data
          const audioB64 = msg.audio_event?.audio_base_64
            || msg.audio?.chunk
            || msg.audio?.audio_base_64
            || msg.audio_chunk;
          if (audioB64) {
            playAudioChunk(audioB64);
            setVoiceStatus('Her turn — speaking', 'playing');
          } else {
            console.warn('[ElevenLabs] Audio msg but no audio data found. Keys:', Object.keys(msg));
          }
          break;

        case 'agent_response':
          const agentText = msg.agent_response_event?.agent_response
            || msg.agent_response?.message;
          if (agentText) showHerResponse(agentText);
          break;

        case 'user_transcript':
          const userText = msg.user_transcription_event?.user_transcript
            || msg.user_transcript?.text;
          if (userText) showTranscript(userText, true);
          break;

        case 'interruption':
          stopAudioPlayback();
          break;

        case 'agent_response_correction':
          if (msg.agent_response_correction_event?.corrected_response) {
            showHerResponse(msg.agent_response_correction_event.corrected_response);
          }
          break;

        case 'turn_end':
          setVoiceStatus('Your turn — speak', 'listening');
          break;

        case 'conversation_initiation_metadata':
          console.log('[ElevenLabs] Conversation initialized:', JSON.stringify(msg).substring(0, 500));
          // Check what audio format is configured
          const meta = msg.conversation_initiation_metadata_event || msg;
          console.log('[ElevenLabs] Agent config:', JSON.stringify(meta).substring(0, 500));
          break;

        case 'ping':
          // Respond to pings with the event_id to keep connection alive
          const pingEventId = msg.ping_event?.event_id;
          if (elWs && elWs.readyState === WebSocket.OPEN) {
            elWs.send(JSON.stringify({ type: 'pong', event_id: pingEventId }));
          }
          break;

        case 'error':
          console.error('[ElevenLabs] Error from server:', JSON.stringify(msg));
          setVoiceStatus('Error: ' + (msg.message || msg.error || 'Unknown'), 'error');
          break;

        default:
          console.log('[ElevenLabs] Unhandled message type:', msg.type);
      }
    };

    elWs.onclose = () => {
      console.log('[ElevenLabs] WebSocket closed');
      stopMicCapture();
      isConversationActive = false;
      document.getElementById('mic-btn').classList.remove('recording');
      document.getElementById('mic-pulse').classList.add('hidden');
      document.getElementById('mic-btn').disabled = false;
      setVoiceStatus('Disconnected — tap mic to reconnect');
    };

    elWs.onerror = (err) => {
      console.error('[ElevenLabs] WebSocket error:', err);
      setVoiceStatus('Connection error — tap mic to retry');
      document.getElementById('mic-btn').disabled = false;
      document.getElementById('mic-btn').classList.remove('recording');
    };

  } catch (e) {
    console.error('ElevenLabs start error:', e);
    setVoiceStatus(e.name === 'NotAllowedError' ? 'Mic access denied' : 'Failed to start — tap mic to retry');
    document.getElementById('mic-btn').disabled = false;
    document.getElementById('mic-btn').classList.remove('recording');
    isConversationActive = false;
  }
}

function stopElevenLabsConversation() {
  stopMicCapture();
  if (elWs) { elWs.close(); elWs = null; }
  isConversationActive = false;
  document.getElementById('mic-btn').classList.remove('recording');
  document.getElementById('mic-pulse').classList.add('hidden');
  setVoiceStatus('Conversation paused — tap mic to resume');
}

// ── Mic Capture → ElevenLabs ────────────────────────────────────

function startMicCapture() {
  if (!mediaStream) return;
  audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(mediaStream);
  scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

  scriptProcessor.onaudioprocess = (e) => {
    if (!isConversationActive || !elWs || elWs.readyState !== WebSocket.OPEN) return;
    const float32 = e.inputBuffer.getChannelData(0);
    // Convert to Int16 PCM then base64
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    // ElevenLabs expects base64-encoded audio chunks
    // Use chunked encoding to avoid stack overflow with spread operator
    const bytes = new Uint8Array(int16.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);
    elWs.send(JSON.stringify({
      user_audio_chunk: base64,
    }));
  };

  source.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);
}

function stopMicCapture() {
  if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
}

// ── Audio Playback (ElevenLabs TTS chunks) ──────────────────────
// ElevenLabs may send MP3 or raw PCM depending on agent config.
// We try decodeAudioData (MP3/WAV/OGG) first, fall back to raw PCM.

let audioPlaybackQueue = [];
let isPlayingAudio = false;
let playbackContext = null;
let nextPlayTime = 0;
let detectedAudioFormat = null; // 'encoded' or 'pcm'

async function playAudioChunk(base64Audio) {
  audioPlaybackQueue.push(base64Audio);
  if (!isPlayingAudio) processAudioQueue();
}

async function processAudioQueue() {
  if (audioPlaybackQueue.length === 0) {
    isPlayingAudio = false;
    return;
  }
  isPlayingAudio = true;

  const chunk = audioPlaybackQueue.shift();
  try {
    if (!playbackContext) {
      playbackContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    await playbackContext.resume();

    // Decode base64 to raw bytes
    const binaryStr = atob(chunk);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    let audioBuffer;

    if (detectedAudioFormat !== 'pcm') {
      // Try decoding as encoded audio (MP3, WAV, OGG, AAC)
      try {
        audioBuffer = await playbackContext.decodeAudioData(bytes.buffer.slice(0));
        if (!detectedAudioFormat) {
          detectedAudioFormat = 'encoded';
          console.log('[Audio] Detected encoded format (MP3/WAV)');
        }
      } catch {
        // Not encoded audio — try PCM
        if (!detectedAudioFormat) {
          detectedAudioFormat = 'pcm';
          console.log('[Audio] Encoded decode failed, using PCM 16-bit 16kHz');
        }
      }
    }

    if (!audioBuffer) {
      // Raw PCM 16-bit signed LE at 16kHz
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }
      audioBuffer = playbackContext.createBuffer(1, float32.length, 16000);
      audioBuffer.getChannelData(0).set(float32);
    }

    const source = playbackContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(playbackContext.destination);
    source.onended = () => processAudioQueue();

    // Schedule seamlessly so chunks don't gap
    const now = playbackContext.currentTime;
    if (nextPlayTime < now) nextPlayTime = now;
    source.start(nextPlayTime);
    nextPlayTime += audioBuffer.duration;
  } catch (e) {
    console.warn('[Audio] Playback error:', e.message);
    processAudioQueue();
  }
}

function stopAudioPlayback() {
  audioPlaybackQueue = [];
  isPlayingAudio = false;
  nextPlayTime = 0;
  detectedAudioFormat = null;
}

// ── UI Helpers ──────────────────────────────────────────────────

function setVoiceStatus(text, className) {
  const el = document.getElementById('voice-status');
  document.getElementById('voice-status-text').textContent = text;
  el.className = 'voice-status' + (className ? ' ' + className : '');
}

function updateStateBadge(state) {
  const badge = document.getElementById('state-badge');
  badge.textContent = state;
  badge.className = 'state-badge ' + state;
}

function showTranscript(text, isFinal) {
  const area = document.getElementById('live-transcript');
  area.classList.remove('hidden');
  document.getElementById('transcript-text').textContent = text;
  area.style.opacity = isFinal ? '0.7' : '1';
}

function showHerResponse(text) {
  if (!text) return;
  const area = document.getElementById('her-response-area');
  area.classList.remove('hidden');
  document.getElementById('her-response-text').textContent = text;
}

function showCoachSuggestions(coach) {
  if (!coach?.suggestions?.length) return;
  const panel = document.getElementById('coach-panel');
  panel.classList.remove('hidden');
  document.getElementById('coach-note').textContent = coach.coachNote || '';

  const list = document.getElementById('suggestions-list');
  list.innerHTML = '';
  coach.suggestions.forEach((s) => {
    const card = document.createElement('button');
    card.className = 'suggestion-card';
    card.textContent = s;
    list.appendChild(card);
  });

  // Scroll into view
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── End Session ─────────────────────────────────────────────────

async function endSession() {
  if (!currentSession) return;

  // Stop ElevenLabs conversation
  stopElevenLabsConversation();

  // Close coach WebSocket
  if (coachWs) { coachWs.close(); coachWs = null; }

  const btn = document.getElementById('end-session-btn');
  btn.disabled = true;
  btn.textContent = 'Generating debrief...';

  try {
    const resp = await fetch('/api/sessions/' + currentSession.sessionId + '/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await resp.json();
    if (!resp.ok) { alert(data.error || 'Failed'); return; }
    openFeedbackView(data.feedback);
  } catch (e) {
    console.error('End session error:', e);
    alert('Failed to generate debrief');
  } finally {
    btn.disabled = false;
    btn.textContent = 'End Session';
  }
}

// ── Feedback View ───────────────────────────────────────────────

function openFeedbackView(feedback) {
  const scenario = currentSession.scenario;
  document.getElementById('feedback-scenario').textContent =
    `${scenario.emoji} ${scenario.name} — ${currentSession.difficulty} difficulty`;

  renderTimeline(feedback.stateTimeline || []);
  renderScoreCards(feedback);
  document.getElementById('what-worked').textContent = feedback.whatWorked || '';
  document.getElementById('what-to-improve').textContent = feedback.whatToImprove || '';

  const suggestedSection = document.getElementById('suggested-line-section');
  if (feedback.suggestedLine) {
    suggestedSection.classList.remove('hidden');
    document.getElementById('suggested-line').textContent = feedback.suggestedLine;
  } else {
    suggestedSection.classList.add('hidden');
  }

  renderTurnList(feedback.turnByTurn || []);
  switchView('feedback');
}

function renderTimeline(timeline) {
  const c = document.getElementById('state-timeline');
  c.innerHTML = '';
  timeline.forEach((t, i) => {
    if (i > 0) { const l = document.createElement('div'); l.className = 'timeline-line'; c.appendChild(l); }
    const n = document.createElement('div');
    n.className = 'timeline-node';
    n.innerHTML = `<div class="timeline-dot ${t.state}"></div><span class="timeline-label">${t.state.slice(0,3)}</span><span class="timeline-exchange">#${t.exchange}</span>`;
    c.appendChild(n);
  });
}

function renderScoreCards(feedback) {
  const c = document.getElementById('score-cards');
  const scores = [
    { key: 'openerScore', label: 'Opener' }, { key: 'flowScore', label: 'Flow' },
    { key: 'confidenceScore', label: 'Confidence' }, { key: 'timingScore', label: 'Timing' },
    { key: 'calibrationScore', label: 'Calibration' }, { key: 'exitScore', label: 'Exit' },
    { key: 'overallScore', label: 'Overall', overall: true },
  ];
  c.innerHTML = '';
  scores.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'score-card' + (s.overall ? ' overall' : '');
    card.innerHTML = `<div class="score-value">${feedback[s.key] || 0}</div><div class="score-label">${s.label}</div>`;
    c.appendChild(card);
  });
}

function renderTurnList(turns) {
  const c = document.getElementById('turn-list');
  if (!turns?.length) { c.innerHTML = '<p class="empty-state">No turn data available.</p>'; return; }
  c.innerHTML = '';
  turns.forEach((t) => {
    const item = document.createElement('div');
    item.className = 'turn-item';
    const sc = t.score >= 7 ? 'var(--warm)' : t.score >= 4 ? 'var(--neutral-color)' : 'var(--guarded)';
    item.innerHTML = `
      <div class="turn-header"><span class="turn-number">#${t.exchange}</span><span class="turn-message">${escapeHtml(t.userMessage)}</span><span class="turn-score-badge" style="color:${sc}">${t.score}/10</span></div>
      <div class="turn-detail"><p class="turn-feedback">${escapeHtml(t.feedback)}</p></div>
    `;
    item.querySelector('.turn-header').addEventListener('click', () => item.classList.toggle('expanded'));
    c.appendChild(item);
  });
}

// ── Event Listeners ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initHome();

  // Mic button — starts/stops ElevenLabs conversation
  document.getElementById('mic-btn').addEventListener('click', startElevenLabsConversation);

  // End session
  document.getElementById('end-session-btn').addEventListener('click', endSession);

  // Feedback actions
  document.getElementById('practice-again-btn').addEventListener('click', () => {
    currentSession = null;
    startSession();
  });
  document.getElementById('back-home-btn').addEventListener('click', () => {
    currentSession = null;
    switchView('home');
  });
});
