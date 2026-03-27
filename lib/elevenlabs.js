// ElevenLabs TTS — REST API wrapper
// Returns MP3 audio buffer for a given text + voice ID

const https = require('https');

// Default voices (ElevenLabs preset IDs)
const VOICES = {
  // Female persona voices
  persona_default: 'EXAVITQu4vr4xnSDxMaL',  // Sarah
  persona_warm: 'pFZP5JQG7iQjIQuC4Bku',      // Lily
  persona_cool: 'jBpfuIE2acCO8z3wKNLl',       // Emily
  // Male coach voice
  coach: 'IKne3meq5aSn9XLyUdCD',               // Charlie
};

async function synthesize(text, voiceId) {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY not set');
  }

  const vid = voiceId || VOICES.persona_default;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${vid}`;

  const body = JSON.stringify({
    text,
    model_id: 'eleven_monolingual_v1',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
    },
  });

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', (d) => { errBody += d; });
        res.on('end', () => reject(new Error(`ElevenLabs ${res.statusCode}: ${errBody}`)));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { synthesize, VOICES };
