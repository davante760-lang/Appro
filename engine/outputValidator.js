// Output validator — checks persona response before sending to user

const FORMAL_PHRASES = [
  'i appreciate', "that's a valid point", 'thank you for sharing',
  'i understand your perspective', "that's an interesting observation",
  'i respect that', "that's quite thoughtful", 'i acknowledge',
  'i value your', "that's a great question", 'what a wonderful', 'how fascinating',
];

const COACHING_PHRASES = [
  'you should try', 'a better approach would', 'next time you could',
  "here's a tip", 'my advice', 'you might want to', "i'd suggest", 'pro tip',
];

function validateOutput(response, persona, state, _previousFacts) {
  const failures = [];
  const lower = response.toLowerCase();

  // 1. Length check: <=3 sentences
  const sentences = response.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (sentences.length > 3) {
    failures.push('exceeds_3_sentences');
  }

  // 2. State-appropriate length
  if ((state === 'GUARDED' || state === 'DISENGAGING' || state === 'EXITED') && sentences.length > 2) {
    failures.push('too_long_for_state');
  }

  // 3. Formal language detection
  if (FORMAL_PHRASES.some((p) => lower.includes(p))) {
    failures.push('formal_language_detected');
  }

  // 4. Anti-coaching: she never gives advice mid-conversation
  if (COACHING_PHRASES.some((p) => lower.includes(p))) {
    failures.push('coaching_detected');
  }

  // 5. Max 1 question per response
  const questionMarks = (response.match(/\?/g) || []).length;
  if (questionMarks > 1) {
    failures.push('multiple_questions');
  }

  // 6. No volunteering phone number
  if (/\b(my number is|here's my number|text me at|call me at|my phone)\b/i.test(response)) {
    failures.push('volunteered_phone_number');
  }

  // 7. Character break detection
  if (/\b(as an ai|i'm a language model|i'm not a real person|this is a simulation|roleplay)\b/i.test(response)) {
    failures.push('character_break');
  }

  // 8. EXITED state should be very short
  if (state === 'EXITED' && response.length > 50) {
    failures.push('exited_too_long');
  }

  return { passed: failures.length === 0, failures };
}

function buildCorrectionNote(failures) {
  const corrections = [];

  if (failures.includes('exceeds_3_sentences') || failures.includes('too_long_for_state')) {
    corrections.push('Keep your response shorter — max 2 sentences. Be terse.');
  }
  if (failures.includes('formal_language_detected')) {
    corrections.push('Don\'t use formal phrases like "I appreciate" or "that\'s a valid point". Sound natural and casual.');
  }
  if (failures.includes('coaching_detected')) {
    corrections.push("Don't give him advice or coaching. You're a person in a conversation, not a mentor.");
  }
  if (failures.includes('multiple_questions')) {
    corrections.push('Ask at most 1 question. Keep it natural.');
  }
  if (failures.includes('volunteered_phone_number')) {
    corrections.push("Don't volunteer your phone number. He needs to ask for it.");
  }
  if (failures.includes('character_break')) {
    corrections.push("Stay in character. Don't reference AI, simulations, or roleplay.");
  }
  if (failures.includes('exited_too_long')) {
    corrections.push("You're leaving. One short goodbye line only.");
  }

  return corrections.join('\n');
}

module.exports = { validateOutput, buildCorrectionNote };
