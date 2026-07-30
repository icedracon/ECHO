// Corvin, the Sentinel — clip catalogue for the first move sheet (DESIGN §12).
// Every clip carries hand-tuned msSeq pacing: entrances ease in, holds sell the
// weight, exits settle. These timings are the approved GIF previews, verbatim.
// Frames live in public/pixel/corvin/<dir>/frame_N.png (203 frames, 20 moves).

export interface CorvinClip {
  frames: string[];
  ms: number;
  loop: boolean;
  settle: number;
  msSeq?: number[];
}

const cc = (dir: string, count: number, ms: number, loop: boolean, settle = 0, msSeq?: number[]): CorvinClip => ({
  frames: Array.from({ length: count }, (_, i) => `/pixel/corvin/${dir}/frame_${i}.png?v=1`),
  ms,
  loop,
  settle,
  msSeq,
});

export const CORVIN = {
  // core
  idle: cc("idle", 9, 230, true),
  // the standing watch with WIND: coat ripples, hair drifts (user-directed)
  windidle: cc("windidle", 13, 200, true),
  walkin: cc("walkin", 9, 110, true, 0, [115, 105, 130, 105, 115, 105, 130, 105, 115]),
  walkout: cc("walkout", 9, 110, true, 0, [115, 105, 130, 105, 115, 105, 130, 105, 115]),
  sit: cc("sit", 9, 190, false, 8, [140, 150, 160, 175, 190, 205, 220, 240, 320]),
  bow: cc("bow", 9, 200, false, 8, [180, 190, 210, 240, 420, 240, 210, 190, 200]),
  meditate: cc("meditate", 9, 320, true, 0, [300, 320, 340, 360, 380, 360, 340, 320, 300]),
  // shadow aura (the FULL flare, three stitched stages)
  aurarise: cc("aurarise", 9, 150, false, 8, [420, 140, 140, 140, 140, 150, 150, 160, 170]),
  auraburn: cc("auraburn", 9, 120, true),
  aurasink: cc("aurasink", 9, 160, false, 8, [150, 150, 150, 160, 160, 170, 180, 200, 520]),
  // execution (slow raise -> tension hold -> slam + shadow burst -> recover)
  execraise: cc("execraise", 9, 200, false, 8, [420, 190, 190, 190, 190, 190, 190, 200, 650]),
  execstrike: cc("execstrike", 13, 150, false, 12, [70, 60, 90, 240, 130, 130, 140, 160, 170, 190, 200, 220, 560]),
  // vigil (kneel -> the eagle joins -> rise)
  kneeldown: cc("kneeldown", 11, 180, false, 10, [420, 170, 170, 170, 170, 170, 170, 170, 170, 180, 750]),
  eaglehop: cc("eaglehop", 11, 150, false, 10, [150, 150, 150, 150, 150, 150, 150, 150, 150, 160, 850]),
  kneelrise: cc("kneelrise", 13, 170, false, 12, [170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 190, 550]),
  // storyteller (seated whetstone strokes; tales play over this loop)
  whetstone: cc("whetstone", 11, 210, true, 0, [500, 210, 210, 210, 210, 210, 210, 210, 210, 210, 550]),
  // the YouTube moment: guitar + Artsiv hovering. Getting there is a ritual:
  // the sword crumbles into violet motes (hand-painted, tip first), then he
  // lifts the guitar and the eagle takes off. Both play REVERSED on the way out.
  swordaway: cc("swordaway", 9, 130, false, 8, [150, 130, 130, 130, 130, 130, 140, 160, 220]),
  guitartake: cc("guitartake", 9, 150, false, 8, [170, 150, 150, 150, 150, 160, 170, 190, 240]),
  guitar: cc("guitar", 11, 160, true),
  // power charge (blade ignition, peak holds ~0.9 s)
  charge: cc("charge", 15, 200, false, 14, [450, 200, 200, 200, 190, 180, 170, 300, 340, 300, 180, 170, 180, 200, 520]),
  // Artsiv cycle (takeoff ends with Corvin alone; landing returns to base)
  takeoff: cc("takeoff", 9, 150, false, 8, [420, 150, 150, 150, 150, 150, 150, 150, 150]),
  landing: cc("landing", 9, 150, false, 8, [150, 150, 150, 150, 150, 150, 150, 150, 520]),
  // standalone flying eagle (84x37, engine drives its position)
  artsivfly: cc("artsivfly", 10, 140, true),
  // ---- second sheet ----
  // Unchained (the Devil Trigger analog): crimson blade -> crouch under a
  // towering shadow vortex -> rage loop -> the dark collapses into the arm
  unchrise: cc("unchrise", 13, 130, false, 12, [420, 130, 130, 130, 130, 130, 130, 130, 130, 130, 130, 130, 300]),
  unchburn: cc("unchburn", 9, 120, true),
  unchsink: cc("unchsink", 11, 140, false, 10, [140, 140, 140, 140, 140, 140, 140, 140, 140, 160, 520]),
  // Steam sentinel: the plain watch and the rarer violet magic scan
  huntwatch: cc("huntwatch", 13, 300, true, 0, [500, 220, 210, 200, 420, 620, 420, 620, 420, 260, 220, 240, 700]),
  magicscan: cc("magicscan", 13, 250, false, 12, [480, 220, 210, 260, 300, 200, 170, 150, 150, 220, 260, 300, 650]),
  // Build error: takes the hit, arm flares, never falls
  damage: cc("damage", 11, 160, false, 10, [350, 80, 90, 100, 180, 130, 140, 160, 210, 260, 620]),
  // Разрубание — the full combo (prep -> crescent cleave -> ground smash 0..6 -> recover)
  cleaveprep: cc("cleaveprep", 9, 170, false, 8, [420, 170, 170, 170, 170, 170, 170, 170, 500]),
  cleaveslash: cc("cleaveslash", 11, 80, false, 10, [60, 60, 55, 55, 60, 75, 95, 115, 130, 150, 170]),
  cleavesmash: cc("cleavesmash", 7, 110, false, 6, [70, 70, 60, 90, 240, 160, 150]),
  cleaverecover: cc("cleaverecover", 9, 180, false, 8, [180, 180, 180, 180, 180, 180, 180, 200, 560]),
  // The warm beat: Artsiv preens his hair on big wins
  nuzzle: cc("nuzzle", 13, 300, false, 12, [450, 250, 240, 230, 260, 420, 500, 460, 300, 260, 250, 280, 650]),
  // THE BREAKDOWN (01:00 / 13:00): the sword slips, he goes down on both knees,
  // Artsiv leaves his shoulder for the ground. No aura, no words, no music —
  // the only scene where he has nothing left. The hold loop is deliberately
  // slow: one heavy breath, the bird turning its head, nothing else.
  breakdown: cc("breakdown", 11, 220, false, 10, [500, 200, 200, 200, 200, 200, 200, 200, 220, 260, 700]),
  breakhold: cc("breakhold", 9, 420, true),
  // ---- The grief line (all five, user-directed) ----
  // The letter: never read aloud, never explained. The long hold in the middle
  // IS the scene — he just looks at it.
  letter: cc("letter", 15, 300, false, 14,
    [500, 260, 240, 240, 240, 300, 900, 1400, 900, 300, 260, 240, 240, 260, 700]),
  // The empty road: he turns his back on you and watches for someone. The last
  // frames stretch out on purpose — nothing is going to happen.
  road: cc("road", 13, 300, false, 12,
    [500, 240, 230, 230, 230, 240, 260, 300, 420, 600, 900, 1200, 1600]),
  // Rain: the downpour is hand-drawn over the frames, so it loops seamlessly.
  rain: cc("rain", 16, 110, true),
  // The same road, in the rain (user-directed): when he turns his back on you
  // to watch for someone, it should be pouring.
  roadrain: cc("roadrain", 13, 300, false, 12,
    [500, 240, 230, 230, 230, 240, 260, 300, 420, 600, 900, 1200, 1600]),
  // The cairn: the old Warden's grave, which he dug himself.
  cairn: cc("cairn", 13, 400, false, 12,
    [500, 280, 260, 260, 260, 280, 300, 340, 420, 900, 1600, 1200, 900]),
  // ---- The fight line ----
  // A block: sparks, boots skidding, straight back into guard. 0.7 s total.
  parry: cc("parry", 9, 80, false, 8, [60, 55, 55, 70, 110, 90, 80, 90, 140]),
  // The bridge between the lines: after a real fight he has to breathe.
  winded: cc("winded", 11, 300, false, 10,
    [400, 260, 300, 340, 300, 260, 300, 340, 300, 280, 700]),
  // Artsiv's dive — wings folded, talons forward. Flown by the sky window.
  artsivdive: cc("artsivdive", 11, 90, true),
  // ---- Links: seams between poses (director set 1) ----
  // Almost every one is pinned back to the base stance, so the director can
  // slot them between ANY two scenes without a teleport.
  turnleft: cc("turnleft", 7, 160, false, 6, [420, 150, 150, 150, 160, 180, 400]),
  turnback: cc("turnback", 7, 160, false, 6, [180, 150, 150, 150, 160, 180, 420]),
  stepright: cc("stepright", 9, 170, false, 8, [420, 170, 160, 160, 170, 160, 160, 180, 420]),
  shiftweight: cc("shiftweight", 7, 210, false, 6, [420, 200, 220, 240, 220, 200, 420]),
  leanwall: cc("leanwall", 9, 220, false, 8, [420, 180, 180, 190, 200, 220, 260, 300, 700]),
  leanoff: cc("leanoff", 7, 190, false, 6, [300, 190, 180, 170, 170, 180, 420]),
  crouchcheck: cc("crouchcheck", 9, 220, false, 8, [420, 180, 170, 170, 300, 420, 200, 190, 420]),
  swordshoulder: cc("swordshoulder", 7, 190, false, 6, [420, 180, 170, 170, 180, 200, 500]),
  swordplant: cc("swordplant", 7, 180, false, 6, [300, 170, 160, 160, 170, 190, 420]),
  stretch2: cc("stretch2", 9, 250, false, 8, [420, 220, 240, 260, 280, 260, 240, 220, 420]),
  glanceback: cc("glanceback", 7, 230, false, 6, [420, 140, 130, 420, 260, 200, 420]),
  crouchrest: cc("crouchrest", 9, 300, false, 8, [420, 200, 190, 200, 600, 700, 240, 220, 420]),
  // ---- Micro-reactions: his fine motor life, 0.5-1.5 s each ----
  flinch: cc("flinch", 5, 130, false, 4, [400, 70, 90, 160, 400]),
  coatdust: cc("coatdust", 7, 160, false, 6, [400, 160, 150, 150, 160, 180, 400]),
  nodself: cc("nodself", 5, 250, false, 4, [400, 220, 300, 240, 400]),
  lookarm: cc("lookarm", 7, 280, false, 6, [400, 200, 260, 500, 400, 240, 400]),
  breathfog: cc("breathfog", 7, 300, false, 6, [400, 260, 320, 420, 320, 260, 400]),
  knuckle: cc("knuckle", 7, 170, false, 6, [400, 160, 150, 200, 180, 180, 400]),
  eaglelook: cc("eaglelook", 7, 280, false, 6, [400, 200, 220, 500, 420, 240, 400]),
  hairwind: cc("hairwind", 7, 160, false, 6, [400, 120, 110, 140, 180, 220, 400]),
  // ---- Daily life: the low-energy scenes (sleep is enter/loop/exit) ----
  sleepdown: cc("sleepdown", 11, 260, false, 10, [420, 220, 220, 230, 240, 260, 280, 300, 340, 400, 700]),
  sleeploop: cc("sleeploop", 7, 550, true),
  sleepup: cc("sleepup", 9, 200, false, 8, [500, 180, 170, 170, 180, 190, 200, 220, 420]),
  feedeagle: cc("feedeagle", 11, 240, false, 10, [420, 200, 190, 190, 200, 260, 300, 280, 240, 220, 420]),
  flask: cc("flask", 11, 280, false, 10, [420, 200, 190, 200, 240, 420, 500, 300, 240, 220, 420]),
  // ---- THE BREACH: 96 frames, six parts, one unbroken fight ----
  // Something comes through the Door and he loses the tempo before he wins it.
  // The pacing is the whole point: the exchange is fast, being knocked down is
  // SLOW (he lies there longer than is comfortable), the rise is heavy, and the
  // counter is explosive again.
  bralarm: cc("bralarm", 13, 150, false, 12,
    [400, 150, 140, 130, 130, 120, 120, 120, 130, 140, 160, 200, 420]),
  brclash: cc("brclash", 17, 90, false, 16,
    [90, 80, 70, 70, 75, 80, 70, 70, 80, 90, 100, 110, 120, 130, 150, 180, 260]),
  brthrown: cc("brthrown", 15, 200, false, 14,
    [70, 60, 60, 65, 75, 90, 110, 140, 180, 240, 420, 700, 900, 700, 600]),
  brrise: cc("brrise", 17, 260, false, 16,
    [600, 320, 300, 280, 260, 240, 230, 220, 210, 200, 190, 190, 200, 220, 260, 320, 600]),
  brcounter: cc("brcounter", 17, 120, false, 16,
    [260, 150, 90, 70, 60, 55, 55, 60, 70, 90, 110, 130, 150, 180, 220, 280, 360]),
  brfinish: cc("brfinish", 17, 220, false, 16,
    [140, 90, 80, 240, 150, 140, 150, 160, 180, 200, 220, 240, 260, 300, 360, 440, 700]),
  breakrise: cc("breakrise", 13, 240, false, 12, [700, 230, 230, 230, 230, 230, 240, 240, 250, 260, 280, 300, 700]),
} as const;

export const corvinClipTotal = (c: CorvinClip): number =>
  c.msSeq ? c.msSeq.reduce((a, b) => a + b, 0) : c.frames.length * c.ms;
