// 6 scenarios with metadata — openers from Davante's framework

const SCENARIOS = {
  coffee: {
    id: 'coffee',
    name: 'Coffee Shop',
    emoji: '\u2615',
    description: 'A cozy coffee shop on a weekend morning. Gentle music, warm lighting, people working on laptops.',
    sceneDescription: "She's sitting at a corner table with a latte and a book. The spot next to her is open. She looks relaxed but focused.",
    baseTimePressure: 3,
    venueModifiers: { situational: 1, direct_honest: -1 },
    contextFlags: { she_is_busy: true, mutual_acknowledgment: false, she_is_with_group: false },
  },
  bar: {
    id: 'bar',
    name: 'Bar',
    emoji: '\uD83C\uDF78',
    description: 'A trendy cocktail bar on a Friday evening. Upbeat music, warm dim lighting, social atmosphere.',
    sceneDescription: "She's at the bar, just ordered a drink. Her friends seem to have left or haven't arrived yet. She's scrolling her phone but looks up when you walk by.",
    baseTimePressure: 2,
    venueModifiers: { direct_honest: 1, functional: -1 },
    contextFlags: { she_is_busy: false, mutual_acknowledgment: false, she_is_with_group: false },
  },
  gym: {
    id: 'gym',
    name: 'Gym',
    emoji: '\uD83D\uDCAA',
    description: 'A busy gym during peak hours. People focused on their workouts, ambient gym sounds.',
    sceneDescription: "She's between sets at the cable machine, catching her breath. She has earbuds in but just paused her music to grab water.",
    baseTimePressure: 7,
    venueModifiers: { functional: 1, situational: -1, direct_honest: -1, observational: -1 },
    contextFlags: { she_is_busy: true, mutual_acknowledgment: false, she_is_with_group: false },
  },
  park: {
    id: 'park',
    name: 'Park',
    emoji: '\uD83C\uDF33',
    description: 'A popular city park on a sunny afternoon. People walking dogs, reading, playing frisbee.',
    sceneDescription: "She's walking her dog on the main path. The dog is friendly and just looked at you. She noticed you noticing the dog.",
    baseTimePressure: 2,
    venueModifiers: { observational: 2, generic_compliment: -2 },
    contextFlags: { she_is_busy: false, mutual_acknowledgment: true, she_is_with_group: false },
  },
  bookstore: {
    id: 'bookstore',
    name: 'Bookstore',
    emoji: '\uD83D\uDCDA',
    description: 'An independent bookstore with creaky wooden floors and that amazing book smell. Quiet, browsing atmosphere.',
    sceneDescription: "She's in the fiction section, flipping through a book with a slight smile. She seems in no rush.",
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

// Openers from Davante's framework — shown before conversation starts
const SUGGESTED_OPENERS = {
  coffee: [
    "Is it just me or is the music in here actually good today?",
    "You look way too focused for a coffee shop — what are you working on?",
    "I feel like everyone in here is either writing a screenplay or starting a company",
  ],
  bar: [
    "What are you drinking? I need to know if I can trust your judgment before I sit down",
    "You look like you're having a better night than most people in here",
    "Do people actually meet each other at bars anymore or is this all apps now?",
  ],
  gym: [
    "I've seen you in here a few times — you're consistent. I respect that. I'm Davante",
    "You look like you actually know what you're doing in here. Most people don't",
    "Good workout? You looked locked in",
  ],
  park: [
    "Beautiful day out here. Felt like I had to get outside",
    "Your dog just made my whole day. What's their name?",
    "I feel like everyone in the city came out today",
  ],
  bookstore: [
    "Is that book any good? I've been going back and forth on picking it up",
    "I couldn't help but notice your stack. You have good taste",
    "I'm looking for something good to read this weekend. Any recommendations?",
  ],
  grocery: [
    "Hey — you seem like you know what you're doing. How do you pick a good avocado?",
    "That's a solid cart. Are you cooking something specific?",
    "I always end up buying the same five things. What's your go-to that I should try?",
  ],
};

module.exports = { SCENARIOS, SUGGESTED_OPENERS };
