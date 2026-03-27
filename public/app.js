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

      switch (msg.type) {
        case 'audio':
          // Base64 audio chunk from ElevenLabs TTS — play it
          if (msg.audio_event?.audio_base_64) {
            playAudioChunk(msg.audio_event.audio_base_64);
            setVoiceStatus('Her turn — speaking', 'playing');
          }
          break;

        case 'agent_response':
          // The AI's text response
          if (msg.agent_response_event?.agent_response) {
            showHerResponse(msg.agent_response_event.agent_response);
          }
          break;

        case 'user_transcript':
          // User's speech transcribed
          if (msg.user_transcription_event?.user_transcript) {
            showTranscript(msg.user_transcription_event.user_transcript, true);
          }
          break;

        case 'interruption':
          // User interrupted — stop audio playback
          stopAudioPlayback();
          break;

        case 'agent_response_correction':
          // Corrected transcript
          if (msg.agent_response_correction_event?.corrected_response) {
            showHerResponse(msg.agent_response_correction_event.corrected_response);
          }
          break;

        case 'turn_end':
          setVoiceStatus('Your turn — speak', 'listening');
          break;

        case 'conversation_initiation_metadata':
          console.log('[ElevenLabs] Conversation initialized:', msg.conversation_initiation_metadata_event?.conversation_id);
          break;
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
    const base64 = btoa(String.fromCharCode(...new Uint8Array(int16.buffer)));
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

let audioPlaybackQueue = [];
let isDecodingAudio = false;

async function playAudioChunk(base64Audio) {
  audioPlaybackQueue.push(base64Audio);
  if (!isDecodingAudio) processAudioQueue();
}

async function processAudioQueue() {
  if (audioPlaybackQueue.length === 0) {
    isDecodingAudio = false;
    return;
  }
  isDecodingAudio = true;

  const chunk = audioPlaybackQueue.shift();
  try {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();

    const bytes = atob(chunk);
    const buffer = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);

    const audioBuffer = await audioContext.decodeAudioData(buffer.buffer.slice(0));
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.onended = () => processAudioQueue();
    source.start();
  } catch (e) {
    console.warn('Audio decode error, skipping chunk:', e.message);
    processAudioQueue();
  }
}

function stopAudioPlayback() {
  audioPlaybackQueue = [];
  isDecodingAudio = false;
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
