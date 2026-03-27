// Pipeline orchestrator — runs full engine per user message
// Safety → Scoring → Latent Vars → State Machine → Context → Claude Persona → Validator → Coach Tip

const { getClient } = require('../lib/claude');
const { checkSafety, getSafetyExitResponse } = require('./safety');
const { scoreTurn, updateCumulativeScore, applyRecoveryPenalty } = require('./scoring');
const { updateLatentVars } = require('./latentVars');
const { evaluateTransition } = require('./stateMachine');
const { evaluateOpener } = require('./openerEvaluator');
const { buildSystemPrompt } = require('./contextAssembly');
const { validateOutput, buildCorrectionNote } = require('./outputValidator');
const { generateCoachTip, generateCoachSuggestions } = require('./coachTip');

async function generatePersonaResponse(anthropic, persona, state, latentVars, messages, scenario, exchangeNumber) {
  const systemPrompt = buildSystemPrompt(persona, state, latentVars, scenario, exchangeNumber);

  const formattedMessages = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  let bestAttempt = '';
  let corrections = '';

  for (let attempt = 0; attempt < 3; attempt++) {
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
    if (validation.passed) {
      return text;
    }

    corrections = buildCorrectionNote(validation.failures);
    console.warn(`Output validation failed (attempt ${attempt + 1}):`, validation.failures);
  }

  return bestAttempt;
}

async function runPipeline(userMessage, messages, engineState, persona, scenario, difficulty, userSafetyFlags) {
  const anthropic = getClient();
  const previousState = engineState.currentState;

  // 1. Safety Check
  const safety = await checkSafety(
    anthropic, userMessage, engineState.currentState,
    engineState.ignoredExitCues, userSafetyFlags, engineState.exchangeNumber
  );

  if (!safety.passed) {
    const exitResponse = getSafetyExitResponse(safety.trigger);
    const updatedState = { ...engineState, currentState: 'EXITED' };
    const snapshot = {
      state: 'EXITED',
      latentVars: engineState.latentVars,
      cumulativeScore: engineState.cumulativeScore,
      exchangeNumber: engineState.exchangeNumber,
      consecutiveWeakTurns: engineState.consecutiveWeakTurns,
      consecutiveStrongTurns: engineState.consecutiveStrongTurns,
      ignoredExitCues: engineState.ignoredExitCues,
      chemistrySpikeUsed: engineState.chemistrySpikeUsed,
    };
    return {
      result: {
        herResponse: exitResponse,
        coachTip: { text: 'That crossed a line. In real life, this conversation would be over.', phase: 'critical' },
        turnScore: -10,
        scoreBreakdown: { safety_violation: -10 },
        currentState: 'EXITED',
        exchangeNumber: engineState.exchangeNumber,
        engineSnapshot: snapshot,
        safetyTriggered: true,
      },
      updatedEngineState: updatedState,
    };
  }

  // 2. Score the User's Turn
  const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant')?.content || null;

  let turnScoreResult;
  if (engineState.exchangeNumber === 1 && messages.filter((m) => m.role === 'user').length === 0) {
    const openerScore = await evaluateOpener(anthropic, userMessage, scenario, persona, scenario.contextFlags);
    turnScoreResult = { total: openerScore, breakdown: { opener_evaluation: openerScore } };
  } else {
    turnScoreResult = await scoreTurn(
      anthropic, userMessage, lastAssistantMsg, messages,
      engineState.currentState, scenario, persona, engineState.exchangeNumber
    );
  }

  // Apply recovery penalty
  const adjustedScore = applyRecoveryPenalty(turnScoreResult.total, engineState.consecutiveWeakTurns);

  // 3. Update Cumulative Score
  const newCumulativeScore = updateCumulativeScore(
    engineState.cumulativeScore, adjustedScore,
    engineState.exchangeNumber, engineState.recentTurnScores
  );

  // Track consecutive turns
  const newWeakTurns = adjustedScore <= 0 ? engineState.consecutiveWeakTurns + 1 : 0;
  const newStrongTurns = adjustedScore >= 2 ? engineState.consecutiveStrongTurns + 1 : 0;

  // Check if exit cue was ignored
  let newIgnoredExitCues = engineState.ignoredExitCues;
  if (engineState.currentState === 'DISENGAGING' && adjustedScore < 4) {
    newIgnoredExitCues += 1;
  }

  // 4. Update Latent Variables
  const newLatentVars = updateLatentVars(engineState.latentVars, adjustedScore, engineState.exchangeNumber);

  // 5. State Transition
  const { newState, chemistrySpikeUsed } = evaluateTransition({
    currentState: engineState.currentState,
    cumulativeScore: newCumulativeScore,
    turnScore: adjustedScore,
    consecutiveWeakTurns: newWeakTurns,
    consecutiveStrongTurns: newStrongTurns,
    ignoredExitCues: newIgnoredExitCues,
    exchangeNumber: engineState.exchangeNumber,
    latentVars: newLatentVars,
    chemistrySpikeUsed: engineState.chemistrySpikeUsed,
    randomBand: engineState.randomBand,
  });

  // 6. Generate Persona Response
  const updatedMessages = [
    ...messages,
    { role: 'user', content: userMessage, turnScore: adjustedScore, scoreBreakdown: turnScoreResult.breakdown, order: messages.length },
  ];

  let herResponse;
  if (newState === 'EXITED' && engineState.currentState === 'EXITED') {
    herResponse = '';
  } else {
    herResponse = await generatePersonaResponse(
      anthropic, persona, newState, newLatentVars, updatedMessages, scenario, engineState.exchangeNumber
    );
  }

  // 7. Coach Tip (legacy) + Coach Suggestions (proactive)
  const coachTip = generateCoachTip(adjustedScore, newState, engineState.exchangeNumber, previousState);

  // 7b. Generate proactive coach suggestions (what to say next)
  let coachSuggestions = { suggestions: [], coachNote: '' };
  if (herResponse && newState !== 'EXITED') {
    coachSuggestions = await generateCoachSuggestions(
      anthropic, herResponse, newState, newLatentVars, updatedMessages, persona, scenario, engineState.exchangeNumber
    );
  }

  // 8. Build Snapshot
  const newExchangeNumber = engineState.exchangeNumber + 1;
  const recentTurns = [...engineState.recentTurnScores, adjustedScore].slice(-2);

  const snapshot = {
    state: newState,
    latentVars: newLatentVars,
    cumulativeScore: newCumulativeScore,
    exchangeNumber: newExchangeNumber,
    consecutiveWeakTurns: newWeakTurns,
    consecutiveStrongTurns: newStrongTurns,
    ignoredExitCues: newIgnoredExitCues,
    chemistrySpikeUsed,
  };

  const updatedEngineState = {
    ...snapshot,
    currentState: newState,
    randomBand: engineState.randomBand,
    recentTurnScores: recentTurns,
  };

  return {
    result: {
      herResponse,
      coachTip,
      coachSuggestions,
      turnScore: adjustedScore,
      scoreBreakdown: turnScoreResult.breakdown,
      currentState: newState,
      exchangeNumber: newExchangeNumber,
      engineSnapshot: snapshot,
    },
    updatedEngineState,
  };
}

module.exports = { runPipeline };
