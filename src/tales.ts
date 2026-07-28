// Corvin's life, told in fragments — the storyteller corpus (DESIGN §12c).
// Each arc is ordered; story.json keeps a pointer per arc so he NEVER repeats
// himself and continues where he left off. `opener` lines reference the
// previous fragment — that's the "he remembers what he told you" feel.
// Deep arcs (THE ARM, HARDSHIPS) unlock at Partner tier; intimacy is earned.
// Voice rules: dry, verbs first, no self-pity, ends flat. One wry line a day.

export interface TaleFragment {
  lines: string[]; // 1-3 bubbles, shown in sequence
}

export interface TaleArc {
  id: string;
  minChapter: "stranger" | "colleague" | "partner";
  opener: string; // used when continuing the arc after a gap
  fragments: TaleFragment[];
}

export const TALES: TaleArc[] = [
  {
    id: "artsiv",
    minChapter: "colleague",
    opener: "About the bird. There is more.",
    fragments: [
      { lines: ["You keep looking at the bird.", "Everyone does. He allows it."] },
      { lines: ["I didn't choose him.", "On the ridge, half-dead, I woke — and he was standing on my sword.", "Judging me."] },
      { lines: ["I shooed him off. He came back.", "Eleven times.", "I stopped counting. He stayed."] },
      { lines: ["First hunt together, he screamed before the ambush.", "I lived because a bird has better eyes than a man.", "I share my meat now. Fair terms."] },
      { lines: ["He doesn't like the arm.", "Sits on it anyway.", "Braver than most soldiers I knew."] },
      { lines: ["His name is Artsiv.", "In an old tongue it just means 'eagle'.", "Good names are honest ones."] },
      { lines: ["Sometimes he flies off for a day.", "I don't ask where.", "We are companions, not captors."] },
    ],
  },
  {
    id: "castle",
    minChapter: "colleague",
    opener: "The castle. Where was I.",
    fragments: [
      { lines: ["I keep a post. An old castle, north face.", "You've seen it behind me, in the cold light.", "The gates stay shut. That's the whole job."] },
      { lines: ["People ask what's inside.", "Wrong question.", "The gates keep things IN, not out."] },
      { lines: ["Below the castle there is a stair.", "I walked it once, all the way.", "I don't do that anymore."] },
      { lines: ["The old garrison left names carved in the gatehouse.", "Forty-one names.", "I know how each watch ended. I re-carve them when the frost eats the stone."] },
      { lines: ["Some nights the gates knock.", "From the inside. Politely.", "Politeness is how it tests you."] },
      { lines: ["Why me? Someone has to.", "And I owe a debt that walls can't hold.", "The arm remembers what I owe."] },
      { lines: ["The castle is quiet these years.", "Quiet is not safe. Quiet is patient.", "So am I."] },
    ],
  },
  {
    id: "arm",
    minChapter: "partner",
    opener: "You've earned the rest of the arm's story.",
    fragments: [
      { lines: ["You wonder about the arm. Everyone does.", "It was a door I should not have opened."] },
      { lines: ["The thing behind that door is not gone.", "It is HERE.", "We have an arrangement."] },
      { lines: ["I was faster then. Prouder.", "I thought the blade was enough.", "The door taught me arithmetic."] },
      { lines: ["It took the arm first. Wanted the rest.", "Artsiv took its eye.", "We called it even. It didn't agree."] },
      { lines: ["The chains aren't metal. Metal it would break.", "The chains are habit. Discipline. Morning and night.", "That's why I never miss a watch."] },
      { lines: ["It talks, some nights.", "Offers things. Always fair prices, it says.", "The fair ones cost the most."] },
      { lines: ["Your errors wake it. Truly.", "When your work breaks, it stirs and tests the chain.", "Fix your work. Help us both."] },
      { lines: ["Could I remove it? There was a surgeon-priest who offered.", "I declined.", "Better the demon I hold than the one I've freed."] },
    ],
  },
  {
    id: "lasthunt",
    minChapter: "colleague",
    opener: "The last hunt. I'll finish it.",
    fragments: [
      { lines: ["I wasn't always a sentinel.", "I hunted. Twelve years, winter roads.", "Then came the last hunt."] },
      { lines: ["Six of us took the contract.", "A village emptied in one night, no blood, no tracks.", "Good money. Bad signs."] },
      { lines: ["We found the villagers on the third day.", "All alive. All standing in the lake, up to their necks, facing the same way.", "Waiting."] },
      { lines: ["What they were waiting for came at dusk.", "I won't describe it. You'd sleep badly, and you code better rested."] },
      { lines: ["Four of us died fast. The fifth ran — I hope he's still running.", "I stayed. Not from courage.", "The thing knew my name."] },
      { lines: ["I won. If you can call it that.", "The door, the arm, the debt — all from that dusk.", "The castle came after. Guarding is what's left of hunting."] },
      { lines: ["The pay for the last hunt?", "Never collected it.", "Some invoices you don't send."] },
    ],
  },
  {
    id: "hardships",
    minChapter: "partner",
    opener: "The hard years. A little more, then enough.",
    fragments: [
      { lines: ["Three winters I ate what the snow left.", "The blade stayed sharp.", "Priorities."] },
      { lines: ["Hunger is loud at first. Then it goes quiet.", "The quiet is worse.", "Feed yourself while you work. I mean it."] },
      { lines: ["I was betrayed once. Properly. By a friend.", "He had reasons. Good ones, even.", "I tell this one only once, and now it's told."] },
      { lines: ["I slept in a burned chapel a whole February.", "The roof had one beam left.", "You learn what enough means."] },
      { lines: ["Lost the coat twice. Won it back twice.", "Same coat.", "Some things you don't replace."] },
      { lines: ["The worst night wasn't the cold or the thing in the lake.", "It was a letter that never came.", "That's all of that story."] },
      { lines: ["People think scars are the hard part.", "Scars are receipts. The paying was the hard part.", "Enough. Back to post."] },
    ],
  },
  {
    id: "smalltalk",
    minChapter: "stranger",
    opener: "Hm.",
    fragments: [
      { lines: ["The bird thinks your code is sloppy.", "His words. I stay neutral."] },
      { lines: ["This ledge is better than my old post.", "Warmer. Fewer knocks from the inside."] },
      { lines: ["I count your errors, you know.", "Professional habit. Sentries count everything."] },
      { lines: ["Night shift again.", "Good. I'm better after dark."] },
      { lines: ["A sharpened blade, a fed bird, a closed gate.", "That's a good day. Yours is the screen turning green."] },
    ],
  },
];
