// Pipeline orchestrator — LIVE mode
// Only one Claude call: persona response. That's it.
// No scoring. No vibe analysis. No safety check.
// You read the room yourself. The coach feeds you lines from your playbook.
// Full scoring happens at session end (debrief).

const { getClient } = require('../lib/claude');
const { buildSystemPrompt } = require('./contextAssembly');
const { validateOutput, buildCorrectionNote } = require('./outputValidator');
const { determineStep, getCoachLines, TIMING } = require('./scriptLibrary');

async function generatePersonaResponse(anthropic, persona, state, latentVars, messages, scenario, exchangeNumber) {
  const systemPrompt = buildSystemPrompt(persona, state, latentVars, scenario, exchangeNumber);

  // Only send last 10 messages to Claude to keep context manageable
  const formattedMessages = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content }));

  let bestAttempt = '';
  let corrections = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    const fullSystem = attempt === 0
      ? systemPrompt
      : `${systemPrompt}\n\nCORRECTION NEEDED:\n${corrections}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      system: fullSystem,
      messages: formattedMessages,
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '...';
    bestAttempt = text;

    const validation = validateOutput(text, persona, state, []);
    if (validation.passed) return text;

    corrections = buildCorrectionNote(validation.failures);
  }

  return bestAttempt;
}

async function runPipeline(userMessage, messages, engineState, persona, scenario, difficulty, _userSafetyFlags) {
  const anthropic = getClient();

  console.log('[Pipeline] Running:', {
    exchange: engineState.exchangeNumber,
    state: engineState.currentState,
    msgCount: messages.length,
    hasLatentVars: !!engineState.latentVars,
    hasPersona: !!persona,
    scenario: scenario?.id,
    difficulty,
  });

  // 1. Generate Persona Response — the ONE Claude call
  const updatedMessages = [
    ...messages,
    { role: 'user', content: userMessage, order: messages.length },
  ];

  let herResponse = '';
  if (engineState.currentState !== 'EXITED') {
    try {
      herResponse = await generatePersonaResponse(
        anthropic, persona, engineState.currentState, engineState.latentVars,
        updatedMessages, scenario, engineState.exchangeNumber
      );
    } catch (err) {
      console.error('[Pipeline] Persona response failed:', err.message, err.stack);
      // Temporarily expose error for debugging — remove later
      herResponse = "DEBUG: " + err.message;
    }
  }

  // 2. Progress the state naturally based on exchange number + difficulty
  // No scoring, no vibe analysis — just natural conversation flow
  const newState = progressState(engineState, difficulty);

  // 3. Determine your step + get coach lines from the playbook (instant)
  const currentStep = determineStep(
    engineState.exchangeNumber,
    newState,
    false, // not tracking her questions — you read the room
    scenario.id
  );
  const coachSuggestions = getCoachLines(currentStep, scenario.id, engineState.exchangeNumber, herResponse);

  // 4. Update engine state
  const newExchangeNumber = engineState.exchangeNumber + 1;

  // Time pressure warning
  if (newExchangeNumber >= TIMING.HARD_STOP_EXCHANGE && currentStep !== 'CLOSE' && currentStep !== 'DONE') {
    coachSuggestions.coachNote = "⏰ HARD STOP — you've been talking too long. Close or walk. Now.";
  }

  const snapshot = {
    state: newState,
    latentVars: engineState.latentVars,
    cumulativeScore: 0,
    exchangeNumber: newExchangeNumber,
    consecutiveWeakTurns: 0,
    consecutiveStrongTurns: 0,
    ignoredExitCues: engineState.ignoredExitCues,
    chemistrySpikeUsed: engineState.chemistrySpikeUsed,
    step: currentStep,
  };

  const updatedEngineState = {
    ...engineState,
    currentState: newState,
    exchangeNumber: newExchangeNumber,
  };

  return {
    result: {
      herResponse,
      coachSuggestions,
      coachTip: null,
      turnScore: 0,
      scoreBreakdown: {},
      currentState: newState,
      currentStep,
      exchangeNumber: newExchangeNumber,
      engineSnapshot: snapshot,
    },
    updatedEngineState,
  };
}

// Simple state progression — she warms up naturally over exchanges
// The persona prompt + difficulty controls HOW she responds
// This just keeps the state moving so the persona prompt stays accurate
function progressState(engineState, difficulty) {
  const exchange = engineState.exchangeNumber;
  const current = engineState.currentState;

  if (current === 'EXITED') return 'EXITED';

  // Warm difficulty — she opens up faster
  if (difficulty === 'warm') {
    if (exchange <= 1) return 'NEUTRAL';
    if (exchange <= 2) return 'WARMING';
    if (exchange <= 4) return 'WARMING';
    return 'ENGAGED';
  }

  // Neutral difficulty — standard progression
  if (difficulty === 'neutral') {
    if (exchange <= 2) return 'NEUTRAL';
    if (exchange <= 4) return 'WARMING';
    if (exchange <= 6) return 'ENGAGED';
    return 'ENGAGED';
  }

  // Guarded difficulty — slow to warm, might disengage
  if (difficulty === 'guarded') {
    if (exchange <= 2) return 'GUARDED';
    if (exchange <= 4) return 'NEUTRAL';
    if (exchange <= 5) return 'WARMING';
    if (exchange <= 7) return 'ENGAGED';
    return 'ENGAGED';
  }

  return current;
}

module.exports = { runPipeline };
