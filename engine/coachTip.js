// Coach — proactive suggestions (what to say next) + post-session debrief

const SUGGESTION_SYSTEM_PROMPT = `You are a social skills coach whispering suggestions to a man practicing approaching someone.
Based on the conversation so far, suggest 2-3 SPECIFIC things he could say next.

Rules:
- Suggest SPECIFIC lines he could actually say out loud, not advice
- Match the tone to the scenario (casual at a bar, quieter in a bookstore)
- If she asked a question, the first suggestion should answer it naturally
- If the state is DISENGAGING, suggest a graceful exit line
- Keep each suggestion under 20 words — these are spoken lines, not paragraphs
- Sound natural. No formal language. Write how a real person talks.
- Include one suggestion that builds on something specific she said

Return ONLY a JSON object:
{
  "suggestions": ["line 1", "line 2", "line 3"],
  "coachNote": "1 sentence on why these work right now"
}`;

async function generateCoachSuggestions(anthropic, herResponse, state, latentVars, messages, persona, scenario, exchangeNumber) {
  // Quick fallback for edge cases
  if (state === 'EXITED') {
    return {
      suggestions: ['Hey, it was nice talking to you. Have a good one.'],
      coachNote: "She's leaving. A clean exit is the move.",
    };
  }

  const recentHistory = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'HIM' : 'HER'}: ${m.content}`)
    .join('\n');

  const prompt = `Scenario: ${scenario.name} — ${scenario.description}
Persona: ${persona.name}, ${persona.age}, ${persona.occupation}
Her personality: playfulness ${persona.personality.playfulness}/10, warmth ${persona.personality.warmth}/10, humor: ${persona.personality.humor_style}
Current state: ${state}
Exchange number: ${exchangeNumber}
Openness: ${latentVars.conversational_openness.toFixed(1)}/10
Comfort: ${latentVars.comfort.toFixed(1)}/10

Her last message: "${herResponse}"

Recent conversation:
${recentHistory}

What should he say next?`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: SUGGESTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    return {
      suggestions: result.suggestions || ['Tell her something about yourself.'],
      coachNote: result.coachNote || '',
    };
  } catch (error) {
    console.error('Coach suggestions error:', error);
    return {
      suggestions: ['Ask her a follow-up question about what she just said.'],
      coachNote: 'Keep the conversation going.',
    };
  }
}

// Legacy coach tip for text-mode fallback (simplified)
function generateCoachTip(turnScore, state, exchangeNumber, previousState) {
  if (previousState && previousState !== state) {
    if (state === 'WARMING' || state === 'ENGAGED') return { text: "She's opening up. Keep this energy.", phase: 'positive' };
    if (state === 'DISENGAGING') return { text: "She's pulling away. Consider exiting gracefully.", phase: 'warning' };
    if (state === 'EXITED') return { text: 'Session over. Respect her exit.', phase: 'critical' };
  }
  if (turnScore >= 3) return { text: 'Good move. Keep building.', phase: 'positive' };
  if (turnScore >= 0) return { text: 'Solid. Try going deeper.', phase: 'neutral' };
  if (turnScore >= -3) return { text: "That didn't land. Adjust.", phase: 'warning' };
  return { text: 'Read the room. Pull back.', phase: 'critical' };
}

const DEBRIEF_SYSTEM_PROMPT = `You are a social skills coach providing a post-session debrief.
Analyze the conversation transcript and provide structured feedback.

Return a JSON object with this exact structure:
{
  "openerScore": <1-10>,
  "flowScore": <1-10>,
  "confidenceScore": <1-10>,
  "timingScore": <1-10>,
  "calibrationScore": <1-10>,
  "exitScore": <1-10>,
  "overallScore": <1-10>,
  "whatWorked": "<2-3 sentences about what he did well>",
  "whatToImprove": "<2-3 sentences about what to work on>",
  "suggestedLine": "<A specific alternative line he could have used at a key moment>",
  "turnByTurn": [
    { "exchange": <number>, "userMessage": "<his message>", "score": <1-10>, "feedback": "<1 sentence>" }
  ]
}

Be specific. Reference actual messages from the conversation. Be encouraging but honest.`;

async function generateDebrief(anthropic, messages, persona, scenario, difficulty, snapshots) {
  const transcript = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'HIM' : 'HER'}: ${m.content}`)
    .join('\n');

  const stateTimeline = snapshots.map((s, i) => ({
    exchange: i + 1,
    state: s.state,
    openness: s.latentVars.conversational_openness,
  }));

  const prompt = `Scenario: ${scenario.name} (${difficulty} difficulty)
Persona: ${persona.name}, ${persona.age}, ${persona.occupation}
State progression: ${snapshots.map((s) => s.state).join(' \u2192 ')}

Transcript:
${transcript}

Analyze this conversation and provide the debrief.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: DEBRIEF_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    return {
      openerScore: result.openerScore || 5,
      flowScore: result.flowScore || 5,
      confidenceScore: result.confidenceScore || 5,
      timingScore: result.timingScore || 5,
      calibrationScore: result.calibrationScore || 5,
      exitScore: result.exitScore || 5,
      overallScore: result.overallScore || 5,
      whatWorked: result.whatWorked || 'No specific strengths identified.',
      whatToImprove: result.whatToImprove || 'Keep practicing.',
      suggestedLine: result.suggestedLine || '',
      stateTimeline,
      turnByTurn: result.turnByTurn || [],
    };
  } catch (error) {
    console.error('Debrief generation error:', error);
    return {
      openerScore: 5, flowScore: 5, confidenceScore: 5, timingScore: 5,
      calibrationScore: 5, exitScore: 5, overallScore: 5,
      whatWorked: 'Error generating detailed feedback.',
      whatToImprove: 'Try another session for detailed feedback.',
      suggestedLine: '', stateTimeline, turnByTurn: [],
    };
  }
}

module.exports = { generateCoachSuggestions, generateCoachTip, generateDebrief };
