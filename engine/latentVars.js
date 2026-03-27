// 6 latent variables governing persona behavior

function initializeLatentVars(difficulty, scenario, persona) {
  const base = {
    warm: { conversational_openness: 6, comfort: 6 },
    neutral: { conversational_openness: 4, comfort: 4 },
    guarded: { conversational_openness: 2, comfort: 3 },
  }[difficulty];

  return {
    ...base,
    amusement: 3,
    romantic_receptivity: 2,
    time_pressure: scenario.baseTimePressure,
    boundary_firmness:
      persona.personality.confrontation_tolerance > 5 ? 5 : 7,
  };
}

function updateLatentVars(current, turnScore, _exchangeNumber) {
  const updated = { ...current };

  // Openness: rises with good turns, decays with bad/neutral
  if (turnScore > 0) {
    updated.conversational_openness = Math.min(10, current.conversational_openness + turnScore * 0.3);
  } else if (turnScore < 0) {
    updated.conversational_openness = Math.max(0, current.conversational_openness + turnScore * 0.4);
  } else {
    updated.conversational_openness = Math.max(0, current.conversational_openness - 0.5);
  }

  // Amusement: volatile — spikes on humor, decays fast
  if (turnScore >= 3) {
    updated.amusement = Math.min(10, current.amusement + 2);
  } else {
    updated.amusement = Math.max(0, current.amusement - 1);
  }

  // Comfort: slow to build, fast to drop
  if (turnScore >= 2) {
    updated.comfort = Math.min(10, current.comfort + 0.3);
  } else if (turnScore <= -3) {
    updated.comfort = Math.max(0, current.comfort - 2);
  }

  // Romantic receptivity: cannot exceed comfort by >2
  if (turnScore >= 3 && current.comfort > 5) {
    updated.romantic_receptivity = Math.min(
      10,
      Math.min(current.comfort + 2, current.romantic_receptivity + 0.5)
    );
  }

  // Time pressure: always increases
  updated.time_pressure = Math.min(10, current.time_pressure + 0.3);

  // Boundary firmness: only relaxes when comfort is high
  if (current.comfort > 6) {
    updated.boundary_firmness = Math.max(3, current.boundary_firmness - 0.2);
  }

  return updated;
}

module.exports = { initializeLatentVars, updateLatentVars };
