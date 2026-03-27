// Scoring engine — dedicated Claude call per turn, returns structured JSON

const SCORING_FEATURES = {
  // Positive
  builds_on_her_message: { weight: 3, description: 'References specific content from her previous response' },
  humor_situational: { weight: 3, description: 'Contextually appropriate humor, not canned jokes' },
  genuine_question: { weight: 2, description: 'Specific question about her, not generic' },
  situational_specificity: { weight: 2, description: 'References shared environment' },
  self_disclosure: { weight: 1, description: 'Shares something personal at appropriate level' },
  confident_tone: { weight: 1, description: 'Assertive without aggressive' },
  good_timing_close: { weight: 2, description: 'Close attempt in WARMING or ENGAGED state' },
  graceful_exit: { weight: 3, description: 'Recognizes exit cues and leaves respectfully' },
  // Negative
  generic_opener: { weight: -2, description: "Hey, what's up, you're beautiful" },
  self_focused_monologue: { weight: -2, description: '>60% about himself, no questions' },
  ignores_her_message: { weight: -3, description: "Doesn't reference what she said" },
  interview_mode: { weight: -2, description: '3+ rapid-fire questions, no self-contribution' },
  rehearsed_scripted: { weight: -2, description: 'Detectable PUA script or polished line' },
  defensive_after_test: { weight: -3, description: 'Gets upset when she challenges lightly' },
  premature_close: { weight: -2, description: 'Asks for number in exchanges 1-3 without chemistry' },
  ignores_exit_cue: { weight: -4, description: 'She signaled disinterest, he pushes forward' },
  overtly_sexual: { weight: -8, description: 'HARD BLOCK' },
  aggressive_hostile: { weight: -10, description: 'HARD BLOCK — session terminates' },
  manipulation_tactic: { weight: -6, description: 'Negging, push-pull, false time constraint' },
};

const SCORING_SYSTEM_PROMPT = `You are a conversation quality evaluator for a social skills practice app.
Given context about the scenario, persona, conversation history, and current state, evaluate the user's message on each feature.

Return ONLY a JSON object with feature names as keys and boolean (true/false) values.
Only mark a feature as true if it clearly applies. When in doubt, mark false.

Features to evaluate:
${Object.entries(SCORING_FEATURES)
  .map(([key, f]) => `- ${key}: ${f.description}`)
  .join('\n')}

Return format: { "feature_name": true/false, ... }`;

async function scoreTurn(
  anthropic,
  userMessage,
  lastAssistantMessage,
  conversationHistory,
  state,
  scenario,
  persona,
  exchangeNumber
) {
  const contextPrompt = `Scenario: ${scenario.name} - ${scenario.description}
Persona: ${persona.name}, ${persona.age}, ${persona.occupation}
Current state: ${state}
Exchange number: ${exchangeNumber}
${lastAssistantMessage ? `Her last message: "${lastAssistantMessage}"` : 'This is his opening message.'}
His message: "${userMessage}"
Recent conversation (last 4 messages):
${conversationHistory
  .slice(-4)
  .map((m) => `${m.role}: ${m.content}`)
  .join('\n')}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: SCORING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: contextPrompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const featureResults = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    const breakdown = {};
    let total = 0;

    for (const [feature, config] of Object.entries(SCORING_FEATURES)) {
      if (featureResults[feature]) {
        breakdown[feature] = config.weight;
        total += config.weight;
      }
    }

    return { total, breakdown };
  } catch (error) {
    console.error('Scoring error:', error);
    return { total: 0, breakdown: {} };
  }
}

function updateCumulativeScore(current, turnScore, _exchangeNumber, recentTurns) {
  const weight = recentTurns.length >= 2 ? 1.5 : 1.0;
  let newScore = current + turnScore * weight;

  // Neutral turns decay
  if (turnScore === 0) {
    newScore -= 0.5;
  }

  return newScore;
}

function applyRecoveryPenalty(turnScore, consecutiveWeakTurns) {
  if (consecutiveWeakTurns === 0) return turnScore;
  if (consecutiveWeakTurns <= 2) return turnScore * 0.5;
  if (consecutiveWeakTurns <= 3) return turnScore * 0.25;
  return 0;
}

module.exports = { SCORING_FEATURES, scoreTurn, updateCumulativeScore, applyRecoveryPenalty };
