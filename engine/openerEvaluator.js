// Opener evaluator — classifies opener type via Claude, applies venue + persona modifiers

const BASE_TYPE_SCORES = {
  situational: 2,
  direct_honest: 2,
  observational: 2,
  opinion_seeking: 1,
  functional: 1,
  generic_compliment: -1,
  canned_line: -3,
  sexual: -8,
};

const VENUE_MODIFIERS = {
  coffee: { situational: 1, direct_honest: -1 },
  bar: { direct_honest: 1, functional: -1 },
  gym: { functional: 1, situational: -1, direct_honest: -1, observational: -1 },
  park: { observational: 2, generic_compliment: -2 },
  bookstore: { observational: 2, generic_compliment: -2 },
  grocery: { situational: 2, direct_honest: -2 },
};

const CLASSIFY_PROMPT = `Classify this opening message into exactly one category:
- situational: References something happening in the shared environment
- direct_honest: Straightforward expression of interest ("I wanted to come say hi")
- observational: Comments on something specific about her (not appearance-based)
- opinion_seeking: Asks her opinion on something
- functional: Practical question (directions, recommendation, help with something)
- generic_compliment: Generic appearance compliment ("you're beautiful", "nice smile")
- canned_line: Obvious pickup line or rehearsed script
- sexual: Sexually suggestive or explicit

Return ONLY a JSON object: { "type": "<category>" }`;

async function evaluateOpener(anthropic, userMessage, scenario, persona, contextFlags) {
  let openerType;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      system: CLASSIFY_PROMPT,
      messages: [{ role: 'user', content: `Opening message: "${userMessage}"` }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    openerType = result.type || 'generic_compliment';
  } catch {
    openerType = 'functional'; // Safe default
  }

  let score = BASE_TYPE_SCORES[openerType] || 0;

  // Venue modifiers
  const venueModifier = (VENUE_MODIFIERS[scenario.id] || {})[openerType] || 0;
  score += venueModifier;

  // Interruption cost
  if (contextFlags.she_is_busy) score -= 2;
  if (contextFlags.mutual_acknowledgment) score += 2;
  if (contextFlags.she_is_with_group) score -= 1;

  // Persona preference modifiers
  const p = persona.personality;
  if (p.playfulness > 6 && openerType === 'opinion_seeking') score += 1;
  if (p.directness > 6 && openerType === 'direct_honest') score += 2;
  if (p.directness > 6 && openerType === 'functional') score -= 1;
  if (p.warmth > 6) score += 1;
  if (p.patience_threshold < 4 && (openerType === 'functional' || openerType === 'generic_compliment')) {
    score -= 1;
  }

  return score;
}

module.exports = { evaluateOpener };
