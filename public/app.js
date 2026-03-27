// ═══ APPROACH — Voice Chat Client ═══

let currentSession = null;
let selectedScenario = null;
let selectedDifficulty = null;

// Voice state
let ws = null;
let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let isRecording = false;
let isProcessing = false;
let audioQueue = []; // Queue of base64 audio to play sequentially
let isPlayingAudio = false;

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

// ── Voice Chat ──────────────────────────────────────────────────

function openVoiceChat(session) {
  // Set header
  document.getElementById('chat-scenario-emoji').textContent = session.scenario.emoji;
  document.getElementById('chat-scenario-name').textContent = session.scenario.name;
  updateStateBadge(session.initialState || 'NEUTRAL');

  // Scene setter
  document.getElementById('scene-setter').textContent = session.sceneDescription;

  // Reset UI
  setVoiceStatus('Tap mic to start');
  document.getElementById('her-response-area').classList.add('hidden');
  document.getElementById('live-transcript').classList.add('hidden');
  document.getElementById('coach-panel').classList.add('hidden');

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
      chip.addEventListener('click', () => {
        // Put in text input as fallback
        document.getElementById('chat-input').value = opener;
      });
      openersList.appendChild(chip);
    });
  }

  // Connect WebSocket
  connectWebSocket(session.sessionId);

  switchView('chat');
}

function connectWebSocket(sessionId) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    console.log('[WS] Connected');
    // Start voice session
    ws.send(JSON.stringify({ type: 'voice.start', sessionId }));
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    switch (msg.type) {
      case 'voice.ready':
        setVoiceStatus('Ready — tap mic to speak');
        document.getElementById('mic-btn').disabled = false;
        break;

      case 'transcript.interim':
        showTranscript(msg.text, msg.isFinal);
        break;

      case 'transcript.final':
        showTranscript(msg.text, true);
        setVoiceStatus('Processing...');
        break;

      case 'pipeline.started':
        isProcessing = true;
        setVoiceStatus('Thinking...', 'processing');
        break;

      case 'response.text':
        isProcessing = false;
        showHerResponse(msg.herResponse);
        showCoachSuggestions(msg.coachSuggestions);
        updateStateBadge(msg.currentState);
        // Hide openers after first exchange
        document.getElementById('openers-panel').classList.add('hidden');
        if (msg.safetyTriggered || msg.currentState === 'EXITED') {
          setVoiceStatus('Session ended', '');
          document.getElementById('mic-btn').disabled = true;
        }
        break;

      case 'response.audio':
        // Queue her voice audio
        audioQueue.push({ audio: msg.audio, label: 'her' });
        playNextAudio();
        break;

      case 'coach.audio':
        // Queue coach audio (plays after hers)
        audioQueue.push({ audio: msg.audio, label: 'coach' });
        playNextAudio();
        break;

      case 'session.exited':
        setVoiceStatus('Session ended');
        document.getElementById('mic-btn').disabled = true;
        break;

      case 'error':
        console.error('[WS] Error:', msg.message);
        setVoiceStatus('Error — try again');
        isProcessing = false;
        break;
    }
  };

  ws.onclose = () => console.log('[WS] Disconnected');
  ws.onerror = (e) => console.error('[WS] Error:', e);
}

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
  if (isFinal) {
    area.style.opacity = '0.7';
  } else {
    area.style.opacity = '1';
  }
}

function showHerResponse(text) {
  if (!text) return;
  const area = document.getElementById('her-response-area');
  area.classList.remove('hidden');
  document.getElementById('her-response-text').textContent = text;
  setVoiceStatus('Her turn — listen', 'playing');
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
    card.addEventListener('click', () => {
      // Put suggestion in text input for reference
      document.getElementById('chat-input').value = s;
    });
    list.appendChild(card);
  });
}

// ── Audio Playback (MP3 from base64) ────────────────────────────

async function playNextAudio() {
  if (isPlayingAudio || audioQueue.length === 0) return;
  isPlayingAudio = true;

  const item = audioQueue.shift();
  if (item.label === 'her') {
    setVoiceStatus('Speaking...', 'playing');
  } else if (item.label === 'coach') {
    setVoiceStatus('Coach speaking...', 'suggesting');
  }

  try {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const bytes = atob(item.audio);
    const buffer = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);

    const audioBuffer = await audioContext.decodeAudioData(buffer.buffer);
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.onended = () => {
      isPlayingAudio = false;
      if (audioQueue.length > 0) {
        // Small pause between her voice and coach
        setTimeout(() => playNextAudio(), 500);
      } else {
        setVoiceStatus('Your turn — tap mic to speak', 'suggesting');
      }
    };
    source.start();
  } catch (e) {
    console.error('Audio playback error:', e);
    isPlayingAudio = false;
    if (audioQueue.length > 0) playNextAudio();
    else setVoiceStatus('Your turn — tap mic', 'suggesting');
  }
}

// ── Mic Recording ───────────────────────────────────────────────

async function startRecording() {
  if (isRecording || isProcessing) return;

  try {
    // Resume audio context (needed after user gesture)
    if (audioContext) audioContext.resume();

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(mediaStream);

    // ScriptProcessor to capture PCM and send via WebSocket
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    scriptProcessor.onaudioprocess = (e) => {
      if (!isRecording || !ws || ws.readyState !== WebSocket.OPEN) return;
      const float32 = e.inputBuffer.getChannelData(0);
      // Convert Float32 → Int16 PCM
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      ws.send(int16.buffer);
    };

    source.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    isRecording = true;
    document.getElementById('mic-btn').classList.add('recording');
    document.getElementById('mic-pulse').classList.remove('hidden');
    setVoiceStatus('Listening...', 'listening');
    document.getElementById('live-transcript').classList.remove('hidden');
    document.getElementById('transcript-text').textContent = '';

    // Hide old coach suggestions while recording
    document.getElementById('coach-panel').classList.add('hidden');
  } catch (e) {
    console.error('Mic error:', e);
    setVoiceStatus('Mic access denied');
  }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }

  document.getElementById('mic-btn').classList.remove('recording');
  document.getElementById('mic-pulse').classList.add('hidden');
  setVoiceStatus('Processing...', 'processing');
}

// ── Text Fallback ───────────────────────────────────────────────

function sendTextMessage() {
  const input = document.getElementById('chat-input');
  const content = input.value.trim();
  if (!content || !ws || ws.readyState !== WebSocket.OPEN || !currentSession) return;

  input.value = '';
  showTranscript(content, true);
  setVoiceStatus('Processing...', 'processing');
  document.getElementById('openers-panel').classList.add('hidden');
  document.getElementById('coach-panel').classList.add('hidden');

  ws.send(JSON.stringify({
    type: 'text.send',
    sessionId: currentSession.sessionId,
    content,
  }));
}

// ── End Session ─────────────────────────────────────────────────

async function endSession() {
  if (!currentSession) return;

  // Stop recording if active
  if (isRecording) stopRecording();

  // Close voice WebSocket
  if (ws) {
    ws.send(JSON.stringify({ type: 'voice.stop' }));
    ws.close();
    ws = null;
  }

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

  // Mic button: click to toggle recording
  const micBtn = document.getElementById('mic-btn');
  micBtn.addEventListener('click', () => {
    if (isRecording) stopRecording();
    else startRecording();
  });

  // Text fallback: Enter to send
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTextMessage(); }
  });
  document.getElementById('send-btn').addEventListener('click', sendTextMessage);

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
