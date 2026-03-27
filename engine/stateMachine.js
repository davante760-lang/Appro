// 6-state conversation FSM with random band per session

function evaluateTransition(ctx) {
  const {
    currentState: s,
    cumulativeScore: cum,
    turnScore: ts,
    consecutiveWeakTurns: weak,
    consecutiveStrongTurns: strong,
    ignoredExitCues,
    latentVars: lv,
    chemistrySpikeUsed,
    randomBand: rb,
  } = ctx;

  // Universal exit conditions
  if (lv.conversational_openness < 2 && s !== 'EXITED') {
    return { newState: 'DISENGAGING', chemistrySpikeUsed };
  }
  if (ignoredExitCues >= 2) {
    return { newState: 'EXITED', chemistrySpikeUsed };
  }

  // Chemistry spike: one-time jump if turnScore >= 6
  if (ts >= 6 && !chemistrySpikeUsed) {
    const jumpMap = {
      GUARDED: 'WARMING',
      NEUTRAL: 'ENGAGED',
      WARMING: 'ENGAGED',
      ENGAGED: 'ENGAGED',
      DISENGAGING: 'NEUTRAL',
      EXITED: 'EXITED',
    };
    return { newState: jumpMap[s], chemistrySpikeUsed: true };
  }

  let newState;

  switch (s) {
    case 'GUARDED':
      if (ts >= 3 || cum >= 5 + rb) newState = 'NEUTRAL';
      else if (cum <= -5 + rb) newState = 'DISENGAGING';
      else newState = 'GUARDED';
      break;

    case 'NEUTRAL':
      if (strong >= 2 || cum >= 10 + rb) newState = 'WARMING';
      else if (ts <= -3) newState = 'GUARDED';
      else if (lv.conversational_openness < 2 || lv.time_pressure > 8 + rb)
        newState = 'DISENGAGING';
      else newState = 'NEUTRAL';
      break;

    case 'WARMING':
      if (cum >= 18 + rb || lv.romantic_receptivity > 6) newState = 'ENGAGED';
      else if (weak >= 2) newState = 'NEUTRAL';
      else if (ts <= -4) newState = 'DISENGAGING';
      else newState = 'WARMING';
      break;

    case 'ENGAGED':
      if (ts <= -2) newState = 'WARMING';
      else if (weak >= 3) newState = 'DISENGAGING';
      else newState = 'ENGAGED';
      break;

    case 'DISENGAGING':
      if (ts >= 4 + rb) newState = 'NEUTRAL';
      else if (ignoredExitCues >= 1) newState = 'EXITED';
      else newState = 'DISENGAGING';
      break;

    case 'EXITED':
      newState = 'EXITED';
      break;

    default:
      newState = s;
  }

  return { newState, chemistrySpikeUsed };
}

// Seeded PRNG (mulberry32) for session-consistent random band
function seededRandom(seed) {
  let t = seed + 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function generateRandomBand(sessionSeed) {
  if (sessionSeed !== undefined) {
    return seededRandom(sessionSeed) * 3 - 1.5; // ±1.5
  }
  return Math.random() * 3 - 1.5;
}

module.exports = { evaluateTransition, generateRandomBand };
