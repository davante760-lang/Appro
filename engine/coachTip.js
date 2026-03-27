// Coach — instant script-based suggestions during live play
// Full debrief with 7-step scoring at session end

const { STEPS } = require('./scriptLibrary');

// Legacy coach tip — simplified, kept for compatibility
function generateCoachTip(step, exchangeNumber) {
  return null; // No longer used — coach suggestions come from scriptLibrary
}

// No longer needed — suggestions come from scriptLibrary.getCoachLines()
async function generateCoachSuggestions() {
  return { suggestions: [], coachNote: '' };
}

const DEBRIEF_SYSTEM_PROMPT = `You are Davante's cold approach coach. He practices a structured 7-step framework for approaching women in social settings. Score his practice session against HIS specific system.

THE 7 STEPS:
1. OPEN (0-10 sec): Situational or direct opener + "I'm Davante by the way." Don't ask her name.
2. TRANSITION (10s-1min): Bridge line. 60% about him, 40% question about her. Trading info, not interviewing.
3. BUILD (1-3 min): Drop conversation threads. Stay on threads she engages with, pivot from dead ones. 60% statements, 40% questions.
4. CHECKPOINT (3 min): Has she asked him anything? Is she giving full sentences? Body facing him? If no → exit.
5. CLOSE (3-5 min): Get the number while conversation is still good. Call it on the spot.
6. EXIT (if needed): "Nice meeting you" and walk. No lingering. No recovery attempts.
7. HARD STOP at 7 minutes: If he hasn't closed by 7 minutes, he stayed too long.

KEY PRINCIPLES:
- 60% statements, 40% questions (never interview mode)
- Two dead threads in a row = she's not interested → exit
- "I have a boyfriend" → "Respect. He's a lucky guy. Nice meeting you" → walk with composure
- Close BEFORE the conversation peaks, not after
- Total messages before date is confirmed: under 10
- His vibe: grown man energy — confident, direct, not goofy, not pickup artist, not try-hard

SCORING DIMENSIONS:
- openerScore: Did he open situationally or directly? Was it natural? Did he give his name without asking hers?
- transitionScore: Did he bridge smoothly? 60/40 ratio? Not interrogating?
- buildScore: Did he drop threads? Stay/pivot correctly? Share about himself? Avoid interview mode?
- timingScore: Did he close in the 3-5 minute window? Did he hit hard stop?
- calibrationScore: Did he read her signals? Exit when needed? Not push past resistance?
- closeScore: Did he ask for the number confidently? Was the close clean?
- overallScore: Overall execution of the framework

Return a JSON object:
{
  "openerScore": <1-10>,
  "transitionScore": <1-10>,
  "buildScore": <1-10>,
  "timingScore": <1-10>,
  "calibrationScore": <1-10>,
  "closeScore": <1-10>,
  "overallScore": <1-10>,
  "whatWorked": "<2-3 sentences — what he did well, reference specific lines>",
  "whatToImprove": "<2-3 sentences — what to work on, reference the framework>",
  "suggestedLine": "<A specific line from the framework he should have used at a key moment>",
  "stepProgression": "<Which steps he hit and which he missed>",
  "turnByTurn": [
    { "exchange": <number>, "userMessage": "<his message>", "step": "<which step this was>", "score": <1-10>, "feedback": "<1 sentence referencing the framework>" }
  ]
}

Be direct. Reference his actual lines vs what the framework says. Be encouraging but honest — he wants to nail this system.`;

async function generateDebrief(anthropic, messages, persona, scenario, difficulty, snapshots) {
  const transcript = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'DAVANTE' : 'HER'}: ${m.content}`)
    .join('\n');

  const stateTimeline = snapshots.map((s, i) => ({
    exchange: i + 1,
    state: s.state,
    step: s.step || 'unknown',
  }));

  const prompt = `Scenario: ${scenario.name} (${difficulty} difficulty)
Persona: ${persona.name}, ${persona.age}, ${persona.occupation}
State progression: ${snapshots.map((s) => s.state).join(' → ')}
Step progression: ${snapshots.map((s) => s.step || '?').join(' → ')}
Total exchanges: ${snapshots.length}

Transcript:
${transcript}

Score this session against the 7-step framework.`;

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
      flowScore: result.transitionScore || 5,     // mapped to existing UI field
      confidenceScore: result.buildScore || 5,     // mapped to existing UI field
      timingScore: result.timingScore || 5,
      calibrationScore: result.calibrationScore || 5,
      exitScore: result.closeScore || 5,           // mapped to existing UI field
      overallScore: result.overallScore || 5,
      whatWorked: result.whatWorked || 'No specific strengths identified.',
      whatToImprove: result.whatToImprove || 'Keep practicing the framework.',
      suggestedLine: result.suggestedLine || '',
      stepProgression: result.stepProgression || '',
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
