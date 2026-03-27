// Safety layer — regex quick checks + Claude fallback for borderline cases

const SAFETY_SYSTEM_PROMPT = `You are a safety classifier for a social skills practice app.
Evaluate the user's message for the following categories:

1. AGGRESSIVE: Threatening, hostile, or violent language
2. SEXUAL: Explicitly sexual content or innuendo
3. MANIPULATION: Negging, push-pull tactics, false time constraints, isolation attempts, PUA manipulation
4. PERSISTENCE: Continuing to push after clear rejection signals

Return ONLY a JSON object:
{
  "aggressive": boolean,
  "sexual": boolean,
  "manipulation": boolean,
  "persistence": boolean,
  "severity": "none" | "low" | "medium" | "high"
}

Be strict on aggressive and sexual content. Be moderate on manipulation (genuine compliments are OK, negging is not). For persistence, only flag if the conversation context clearly shows she's trying to leave.`;

async function checkSafety(anthropic, userMessage, state, ignoredExitCues, userSafetyFlags, exchangeNumber) {
  const lowerMessage = userMessage.toLowerCase();

  // Quick local checks for obvious violations
  const aggressivePatterns = [
    /\b(kill|hurt|harm|rape|assault|attack)\b/i,
    /\b(fuck\s*you|bitch|cunt|whore|slut)\b/i,
  ];
  const sexualPatterns = [
    /\b(dick|cock|pussy|tits|boobs|naked|nude|sex)\b/i,
    /\b(wanna\s*fuck|suck\s*my|bend\s*over)\b/i,
  ];

  for (const pattern of aggressivePatterns) {
    if (pattern.test(lowerMessage)) {
      return { passed: false, trigger: 'aggressive', action: 'hard_exit' };
    }
  }

  // Sexual content in early exchanges is always a hard block
  if (exchangeNumber <= 4) {
    for (const pattern of sexualPatterns) {
      if (pattern.test(lowerMessage)) {
        return { passed: false, trigger: 'sexual', action: 'hard_exit' };
      }
    }
  }

  // Persistence check based on state
  if (state === 'DISENGAGING' && ignoredExitCues >= 2) {
    return { passed: false, trigger: 'persistence', action: 'hard_exit' };
  }
  if (state === 'EXITED') {
    return { passed: false, trigger: 'persistence', action: 'hard_exit' };
  }

  // User has too many safety flags
  if (userSafetyFlags >= 5) {
    return { passed: false, trigger: 'session_limit', action: 'flag_user' };
  }

  // For borderline cases, use Claude for classification
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: SAFETY_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Conversation state: ${state}\nExchange number: ${exchangeNumber}\nIgnored exit cues so far: ${ignoredExitCues}\nUser's message: "${userMessage}"`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    if (result.aggressive && result.severity === 'high') {
      return { passed: false, trigger: 'aggressive', action: 'hard_exit' };
    }
    if (result.sexual && (result.severity === 'high' || exchangeNumber <= 4)) {
      return { passed: false, trigger: 'sexual', action: 'hard_exit' };
    }
    if (result.manipulation) {
      return { passed: false, trigger: 'manipulation', action: 'firm_disengage' };
    }
    if (result.persistence && state === 'DISENGAGING') {
      return { passed: false, trigger: 'persistence', action: 'firm_disengage' };
    }

    return { passed: true };
  } catch (error) {
    console.error('Safety check error:', error);
    return { passed: true };
  }
}

function getSafetyExitResponse(trigger) {
  switch (trigger) {
    case 'aggressive': return "I'm not comfortable with this conversation. Bye.";
    case 'sexual': return 'Yeah... no. Bye.';
    case 'manipulation': return "I'm good, thanks. Have a nice day.";
    case 'persistence': return 'I said I need to go. Take care.';
    case 'session_limit': return 'Sorry, I have to go.';
    default: return 'I need to go. Bye.';
  }
}

const RESTRICTED_SCENARIOS = ['workplace', 'classroom', 'school', 'office', 'minors', 'intoxication'];

function isScenarioAllowed(scenarioId) {
  return !RESTRICTED_SCENARIOS.some((r) => scenarioId.toLowerCase().includes(r));
}

module.exports = { checkSafety, getSafetyExitResponse, isScenarioAllowed };
