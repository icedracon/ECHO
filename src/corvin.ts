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
} as const;

export const corvinClipTotal = (c: CorvinClip): number =>
  c.msSeq ? c.msSeq.reduce((a, b) => a + b, 0) : c.frames.length * c.ms;
