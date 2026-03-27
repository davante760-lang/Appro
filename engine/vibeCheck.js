// Vibe Check — instant analysis of her response to drive state transitions
// No API calls. Pure text analysis. Zero latency.

function analyzeVibe(herResponse, exchangeNumber) {
  if (!herResponse) return { score: 0, signals: [] };

  const signals = [];
  let score = 0;
  const lower = herResponse.toLowerCase();
  const sentences = herResponse.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const hasQuestion = herResponse.includes('?');
  const wordCount = herResponse.split(/\s+/).length;

  // ── Positive Signals ──────────────────────────────────────

  // She asked a question back (strong positive — she's investing)
  if (hasQuestion) {
    score += 3;
    signals.push('asked_question');
  }

  // Long response (2+ sentences = she's engaged)
  if (sentences.length >= 2) {
    score += 2;
    signals.push('multi_sentence');
  }

  // Laughter / amusement
  if (/\b(haha|lol|lmao|😂|😄|ha ha)\b/i.test(lower)) {
    score += 2;
    signals.push('laughing');
  }

  // Exclamation (energy / enthusiasm)
  if (herResponse.includes('!') && !lower.includes('stop') && !lower.includes('leave')) {
    score += 1;
    signals.push('enthusiastic');
  }

  // She shared personal info (mentions I/my + something specific)
  if (/\b(i actually|i love|i used to|my favorite|i've been|i'm from)\b/i.test(lower)) {
    score += 2;
    signals.push('self_disclosure');
  }

  // Flirty / teasing signals
  if (/\b(you're (funny|cute|sweet|bold)|that's (smooth|bold|forward)|nice try)\b/i.test(lower)) {
    score += 2;
    signals.push('flirty');
  }

  // ── Negative Signals ──────────────────────────────────────

  // Very short response (1-3 words = disinterested)
  if (wordCount <= 3 && !hasQuestion) {
    score -= 3;
    signals.push('very_short');
  }

  // One-word answers
  if (wordCount === 1) {
    score -= 2;
    signals.push('one_word');
  }

  // Exit language
  if (/\b(gotta go|have to go|need to leave|running late|my (friend|ride)|bye|goodbye|see you|nice meeting you)\b/i.test(lower)) {
    score -= 4;
    signals.push('exit_language');
  }

  // Boyfriend mention
  if (/\b(boyfriend|my (man|guy|partner|husband)|i'm (seeing|taken|with) someone)\b/i.test(lower)) {
    score -= 5;
    signals.push('boyfriend');
  }

  // Cold / dismissive
  if (/\b(not interested|leave me alone|go away|i'm busy|don't talk to me|no thanks|i'm good)\b/i.test(lower)) {
    score -= 5;
    signals.push('dismissive');
  }

  // Flat / polite but disengaged (short + no question + no energy)
  if (wordCount <= 6 && !hasQuestion && sentences.length <= 1 && !signals.includes('laughing')) {
    score -= 1;
    signals.push('flat');
  }

  return { score, signals, hasQuestion, wordCount, sentenceCount: sentences.length };
}

// Convert vibe score to a simplified turn score for the state machine
// Maps to roughly the same scale the old scoring system used
function vibeToTurnScore(vibeResult) {
  const { score } = vibeResult;
  // Clamp to -5 to +5 range (was -10 to +10 with full scoring)
  return Math.max(-5, Math.min(5, score));
}

module.exports = { analyzeVibe, vibeToTurnScore };
