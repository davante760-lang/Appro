// 6 scenarios with metadata, context flags, and suggested openers

const SCENARIOS = {
  coffee: {
    id: 'coffee',
    name: 'Coffee Shop',
    emoji: '\u2615',
    description: 'A cozy coffee shop on a weekend morning. Gentle music, warm lighting, people working on laptops.',
    sceneDescription: "She's sitting at a corner table with a latte and a book. The spot next to her is open.",
    baseTimePressure: 3,
    venueModifiers: { situational: 1, direct_honest: -1 },
    contextFlags: { she_is_busy: true, mutual_acknowledgment: false, she_is_with_group: false },
  },
  bar: {
    id: 'bar',
    name: 'Bar',
    emoji: '\uD83C\uDF78',
    description: 'A trendy cocktail bar on a Friday evening. Upbeat music, warm dim lighting, social atmosphere.',
    sceneDescription: "She's at the bar, just ordered a drink. Her friends seem to have left or haven't arrived yet.",
    baseTimePressure: 2,
    venueModifiers: { direct_honest: 1, functional: -1 },
    contextFlags: { she_is_busy: false, mutual_acknowledgment: false, she_is_with_group: false },
  },
  gym: {
    id: 'gym',
    name: 'Gym',
    emoji: '\uD83D\uDCAA',
    description: 'A busy gym during peak hours. People focused on their workouts, ambient gym sounds.',
    sceneDescription: "She's between sets at the cable machine, catching her breath. She has earbuds in but just paused her music.",
    baseTimePressure: 7,
    venueModifiers: { functional: 1, situational: -1, direct_honest: -1, observational: -1 },
    contextFlags: { she_is_busy: true, mutual_acknowledgment: false, she_is_with_group: false },
  },
  park: {
    id: 'park',
    name: 'Park',
    emoji: '\uD83C\uDF33',
    description: 'A popular city park on a sunny afternoon. People walking dogs, reading, playing frisbee.',
    sceneDescription: "She's walking her dog on the main path. The dog seems friendly and just sniffed in your direction.",
    baseTimePressure: 2,
    venueModifiers: { observational: 2, generic_compliment: -2 },
    contextFlags: { she_is_busy: false, mutual_acknowledgment: true, she_is_with_group: false },
  },
  bookstore: {
    id: 'bookstore',
    name: 'Bookstore',
    emoji: '\uD83D\uDCDA',
    description: 'An independent bookstore with creaky wooden floors and that amazing book smell. Quiet, browsing atmosphere.',
    sceneDescription: "She's in the fiction section, flipping through a book with a slight smile.",
    baseTimePressure: 3,
    venueModifiers: { observational: 2, generic_compliment: -2 },
    contextFlags: { she_is_busy: true, mutual_acknowledgment: false, she_is_with_group: false },
  },
  grocery: {
    id: 'grocery',
    name: 'Grocery Store',
    emoji: '\uD83D\uDED2',
    description: 'A nice grocery store on a Sunday afternoon. People doing their weekly shopping, relatively relaxed.',
    sceneDescription: "She's in the produce section, carefully picking avocados. She looks like she knows what she's doing.",
    baseTimePressure: 4,
    venueModifiers: { situational: 2, direct_honest: -2 },
    contextFlags: { she_is_busy: true, mutual_acknowledgment: false, she_is_with_group: false },
  },
};

const SUGGESTED_OPENERS = {
  coffee: [
    "Is that any good? I've been looking for something new to read.",
    "This might be random but I wanted to come say hi. I'm [name].",
    "Excuse me — do you know if the oat milk lattes here are good? I usually go to the other place down the street.",
  ],
  bar: [
    'What are you drinking? I need to branch out from my usual.',
    "Hey, I'm [name]. I don't usually do this but you seemed like someone worth talking to.",
    'Are you waiting for someone or can I steal the seat next to you for a minute?',
  ],
  gym: [
    'Hey, are you done with the cables? No rush.',
    "Sorry to bother you between sets — do you know if they have any more of those resistance bands?",
    "Nice form on those. How long have you been training?",
  ],
  park: [
    "Hey! What kind of dog is that? Super cute.",
    "Your dog just made my whole day. What's their name?",
    'Beautiful day. I feel like everyone in the city came out today.',
  ],
  bookstore: [
    "Oh nice — have you read that one? I've been going back and forth on picking it up.",
    "Sorry — I couldn't help but notice your stack. You have good taste.",
    "I'm looking for something good to read this weekend. Any recommendations?",
  ],
  grocery: [
    "Hey — you seem like you know what you're doing. How do you pick a good avocado?",
    "That's a solid cart. Are you cooking something specific?",
    "I always end up buying the same five things. What's your go-to that I should try?",
  ],
};

module.exports = { SCENARIOS, SUGGESTED_OPENERS };
