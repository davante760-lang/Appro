// Deepgram STT Streaming Proxy — Raw WebSocket
// Ported from interview-coach/lib/deepgram-raw.js

const WebSocket = require('ws');

class DeepgramProxy {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.connections = new Map();
    console.log('[Deepgram] Proxy initialized, key:', apiKey ? (apiKey.slice(0, 8) + '...') : 'MISSING');
  }

  createSession(sessionId, onTranscript, onError, onReady) {
    console.log('[Deepgram] Creating session', sessionId);

    const params = new URLSearchParams({
      model: 'nova-2',
      language: 'en',
      smart_format: 'false',
      interim_results: 'true',
      utterance_end_ms: '1200',
      vad_events: 'false',
      punctuate: 'true',
      diarize: 'false',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
    });

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    try {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });

      const session = {
        ws,
        intentionalClose: false,
        keepaliveInterval: null,
        sessionId,
        lastAudioTime: Date.now(),
        _chunkCount: 0,
      };

      ws.on('open', () => {
        console.log('[Deepgram] Session', sessionId, 'OPEN');
        this.connections.set(sessionId, session);

        // Keepalive: send silence + KeepAlive JSON every 3s
        session.keepaliveInterval = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          try {
            const timeSinceAudio = Date.now() - session.lastAudioTime;
            if (timeSinceAudio > 2000) {
              const silence = new Int16Array(1600); // 100ms at 16kHz
              ws.send(Buffer.from(silence.buffer));
            }
            ws.send(JSON.stringify({ type: 'KeepAlive' }));
          } catch (e) {
            console.warn('[Deepgram] KeepAlive failed:', e.message);
          }
        }, 3000);

        if (onReady) onReady();
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'Results') {
            const alt = msg.channel?.alternatives?.[0];
            if (alt?.transcript) {
              onTranscript({
                text: alt.transcript,
                confidence: alt.confidence,
                isFinal: msg.is_final,
                speechFinal: msg.speech_final,
              });
            }
          } else if (msg.type === 'UtteranceEnd') {
            onTranscript({ type: 'utterance_end', timestamp: Date.now() });
          }
        } catch (_e) {
          // Binary or parse error — ignore
        }
      });

      ws.on('error', (error) => {
        console.error('[Deepgram] Session', sessionId, 'ERROR:', error.message);
        if (onError) onError(error);
      });

      ws.on('close', (code) => {
        console.log('[Deepgram] Session', sessionId, 'CLOSED, code:', code);
        this.connections.delete(sessionId);
        if (session.keepaliveInterval) {
          clearInterval(session.keepaliveInterval);
        }
      });
    } catch (error) {
      console.error('[Deepgram] Failed to create session:', error);
      if (onError) onError(error);
    }
  }

  sendAudio(sessionId, audioData) {
    const session = this.connections.get(sessionId);
    if (session?.ws?.readyState === WebSocket.OPEN) {
      try {
        session.lastAudioTime = Date.now();
        session.ws.send(audioData);
      } catch (error) {
        console.error('[Deepgram] Send audio error:', error.message);
      }
    }
  }

  closeSession(sessionId) {
    const session = this.connections.get(sessionId);
    if (session) {
      session.intentionalClose = true;
      if (session.keepaliveInterval) clearInterval(session.keepaliveInterval);
      try {
        if (session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
        session.ws.close();
      } catch (_e) { /* ignore */ }
      this.connections.delete(sessionId);
    }
  }
}

module.exports = DeepgramProxy;
