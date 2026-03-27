// Davante's 7-Step Approach Framework — Script Library
// All lines organized by step + venue for instant coach lookup

const STEPS = {
  OPEN: 'OPEN',           // 0-10 seconds — opener + "I'm Davante by the way"
  TRANSITION: 'TRANSITION', // 10s-1min — bridge to real conversation
  BUILD: 'BUILD',         // 1-3 min — find the thread that sparks
  CHECKPOINT: 'CHECKPOINT', // 3 min — read: is she engaged or not?
  CLOSE: 'CLOSE',         // 3-5 min — get the number
  EXIT: 'EXIT',           // Clean exit — she's not interested
  DONE: 'DONE',           // Post-close or post-exit
};

// ── OPENERS by Venue ────────────────────────────────────────────

const OPENERS = {
  coffee: [
    "Is it just me or is the music in here actually good today?",
    "You look way too focused for a coffee shop — what are you working on?",
    "I feel like everyone in here is either writing a screenplay or starting a company",
    "Do people actually like matcha or is everyone pretending?",
  ],
  bar: [
    "What are you drinking? I need to know if I can trust your judgment before I sit down",
    "You look like you're having a better night than most people in here",
    "I like your energy — you seem like you're actually enjoying yourself and not performing for Instagram",
    "Do people actually meet each other at bars anymore or is this all apps now?",
    "You look way too put together for a Tuesday. What's the occasion?",
  ],
  gym: [
    "I've seen you in here a few times — you're consistent. I respect that. I'm Davante",
    "You look like you actually know what you're doing in here. Most people don't",
    "Good workout? You looked locked in",
    "You seem like you take this seriously — not just a New Year's resolution person",
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
  // Direct openers work in any venue
  direct: [
    "I don't usually do this but you caught my eye. I'm Davante",
    "This is going to be very direct — I think you're attractive and I wanted to meet you. I'm Davante",
    "I was about to leave and then I saw you. Figured that was the universe telling me to say hi",
    "I'm going to be straight with you — I noticed you and I wanted to introduce myself before I lost the chance",
    "I'm not going to pretend I have a reason to talk to you other than I wanted to. I'm Davante",
  ],
};

// ── TRANSITION Lines ────────────────────────────────────────────
// Purpose: Move from stranger → conversation. 60% about you, 40% question about her.

const TRANSITIONS = [
  "I'm actually working remote today — this is my excuse to leave the apartment. What about you?",
  "So what's your deal — are you from SD or did you end up here like everyone else?",
  "You don't seem like you're from here originally",
  "Are you always this relaxed or is today special?",
  "You seem like someone who's got it figured out. How long did it take?",
];

// ── BUILD Threads ───────────────────────────────────────────────
// Purpose: Find a topic that sparks energy. Drop a thread, see if she bites.

const BUILD_THREADS = [
  "Are you an early morning person or a night owl?",
  "You strike me as someone who's very independent",
  "You look like someone who has stories to tell",
  "I think you and I would either get along really well or argue about everything. I can't tell yet",
];

// ── CLOSE Lines ─────────────────────────────────────────────────
// Purpose: Get the number while the conversation is still good.

const CLOSE_LINES = [
  "I gotta run but I enjoyed this. Let me get your number",
  "I want to keep talking but I have to go. Give me your number and I'll text you",
  "I have to go but I don't want this to be the last time we talk. Number?",
  "I'm grabbing your number before the universe separates us. Ready?",
  "I'd rather text you than wonder what happened. What's your number?",
];

// ── EXIT Lines ──────────────────────────────────────────────────
// Clean exits — she's not interested or it's time to go.

const EXIT_LINES = [
  "Nice meeting you. Have a good one.",
  "Well it was good to meet you. Enjoy your night.",
  "No worries. Nice meeting you.",
];

// ── RESISTANCE Handlers ─────────────────────────────────────────

const BOYFRIEND_RESPONSES = [
  "Respect. He's a lucky guy. Nice meeting you",
  "That's cool — I'm not asking you to leave him. I just thought you seemed interesting",
  "That's fine — I'm not asking for his spot. Just saying hi",
  "Noted. I still think you're cool though. Enjoy your night",
  "That's okay — I just saw you and wanted to introduce myself regardless",
];

// ── Step Determination Logic ────────────────────────────────────
// Maps exchange number + her state to the current step

function determineStep(exchangeNumber, herState, herAskedQuestion, scenarioId) {
  // Exchange 1 = always OPEN
  if (exchangeNumber <= 1) return STEPS.OPEN;

  // If she's exiting, we should exit
  if (herState === 'EXITED') return STEPS.DONE;
  if (herState === 'DISENGAGING') return STEPS.EXIT;

  // Exchange 2 = TRANSITION
  if (exchangeNumber === 2) return STEPS.TRANSITION;

  // Exchange 3-4 = BUILD
  if (exchangeNumber <= 4) return STEPS.BUILD;

  // Exchange 5+ = CHECKPOINT logic
  // If she's engaged/warming and asking questions → CLOSE
  if ((herState === 'ENGAGED' || herState === 'WARMING') && herAskedQuestion) {
    return STEPS.CLOSE;
  }

  // If she's still just neutral at exchange 5+ → EXIT (she's not interested enough)
  if (herState === 'GUARDED' || (herState === 'NEUTRAL' && exchangeNumber >= 6)) {
    return STEPS.EXIT;
  }

  // Exchange 5-6 with neutral/warming = still building, but close soon
  if (exchangeNumber <= 6) return STEPS.BUILD;

  // Exchange 7+ = HARD STOP — must close or exit
  if (herState === 'WARMING' || herState === 'ENGAGED') return STEPS.CLOSE;
  return STEPS.EXIT;
}

// ── Get Coach Lines for Current Step ────────────────────────────
// Returns instant suggestions from the script library — no AI call needed

function getCoachLines(step, scenarioId, exchangeNumber, herResponse) {
  let suggestions = [];
  let coachNote = '';

  switch (step) {
    case STEPS.OPEN: {
      const venueLines = OPENERS[scenarioId] || OPENERS.coffee;
      // Pick 2 venue-specific + 1 direct
      suggestions = [
        venueLines[Math.floor(Math.random() * venueLines.length)],
        OPENERS.direct[Math.floor(Math.random() * OPENERS.direct.length)],
      ];
      coachNote = "Open with one of these, then say: \"I'm Davante by the way.\" Don't ask her name — she'll give it if she's interested.";
      break;
    }

    case STEPS.TRANSITION: {
      // Pick 2-3 transition lines
      const shuffled = [...TRANSITIONS].sort(() => Math.random() - 0.5);
      suggestions = shuffled.slice(0, 3);
      coachNote = "Bridge into real conversation. 60% about you, 40% question about her. You're trading info, not interviewing.";
      break;
    }

    case STEPS.BUILD: {
      // Pick 2-3 build threads
      const shuffled = [...BUILD_THREADS].sort(() => Math.random() - 0.5);
      suggestions = shuffled.slice(0, 3);
      coachNote = "Drop a thread and see if she bites. If she gives a flat answer, pivot to the next one. Two dead threads = exit.";
      break;
    }

    case STEPS.CHECKPOINT: {
      suggestions = [
        "Check: Has she asked you anything? Is she facing you? Smiling?",
        "If yes → close now. If no → exit clean.",
      ];
      coachNote = "3-minute checkpoint. Read the room. If she hasn't asked you a single question, she's not interested.";
      break;
    }

    case STEPS.CLOSE: {
      const shuffled = [...CLOSE_LINES].sort(() => Math.random() - 0.5);
      suggestions = shuffled.slice(0, 3);
      coachNote = "She's engaged. Close NOW while it's good. Don't wait for it to peak and fade. Get the number, call it on the spot.";
      break;
    }

    case STEPS.EXIT: {
      suggestions = [...EXIT_LINES];
      coachNote = "She's not feeling it. Exit clean. \"Nice meeting you\" and walk. No lingering. No recovery attempts.";
      break;
    }

    case STEPS.DONE: {
      suggestions = [];
      coachNote = "Session complete.";
      break;
    }
  }

  return { suggestions, coachNote, currentStep: step };
}

// ── Timing Rules ────────────────────────────────────────────────

const TIMING = {
  HARD_STOP_EXCHANGE: 8,         // ~7 minutes — if you haven't closed, you stayed too long
  CLOSE_WINDOW_START: 4,         // ~3 minutes — earliest you should close
  CLOSE_WINDOW_END: 7,           // ~5 minutes — latest you should close
  CHECKPOINT_EXCHANGE: 5,        // ~3 minutes — read the room
};

module.exports = {
  STEPS,
  OPENERS,
  TRANSITIONS,
  BUILD_THREADS,
  CLOSE_LINES,
  EXIT_LINES,
  BOYFRIEND_RESPONSES,
  determineStep,
  getCoachLines,
  TIMING,
};
