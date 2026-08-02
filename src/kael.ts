import type { CorvinClip } from "./corvin";

const kv = 2;

const kc = (
  dir: string,
  count: number,
  ms: number,
  loop: boolean,
  settle = 0,
  msSeq?: number[],
): CorvinClip => ({
  frames: Array.from({ length: count }, (_, i) => `/pixel/kael/${dir}/frame_${i}.png?v=${kv}`),
  ms,
  loop,
  settle,
  msSeq,
});

const still = (file: string, ms = 420): CorvinClip => ({
  frames: [`/pixel/kael/${file}.png?v=${kv}`, `/pixel/kael/${file}.png?v=${kv}`],
  ms,
  loop: true,
  settle: 0,
});

export const KAEL = {
  base: still("base"),
  side: still("side"),
  // frame_8 is pixel-identical to frame_0. Runtime omits that duplicate so the
  // contact pose is not held twice at every loop boundary.
  walkin: kc("walkin", 8, 155, true, 0, [170, 150, 160, 150, 170, 150, 160, 150]),

  // Connected v2 motion set. Loops contain no posture changes; every held pose
  // has an explicit enter/exit link owned by the Kael mode controller.
  arrival: kc("arrival", 13, 230, false, 12),
  idle_v2: kc("idle_v2", 9, 420, true, 0),
  breathe: kc("breathe", 9, 420, true, 0),
  cloaksettle: kc("cloaksettle", 13, 230, false, 12),
  razlomtap: kc("razlomtap", 13, 220, false, 12),
  swordplant: kc("swordplant", 13, 260, false, 12),
  platypus_sniff: kc("platypus_sniff", 13, 240, false, 12),
  typing_runes: kc("typing_runes", 9, 320, true, 0),
  // Approved typing-v4 film. The portal owns its open/close contacts and the
  // body clip throws three distinct runes one at a time. Per-frame timing adds
  // anticipation and impact while preserving the reviewed 120 ms average.
  typing_portal_enter: kc("typing_portal_enter", 6, 120, false, 5, [90, 95, 110, 125, 140, 160]),
  typing_runes_v4: kc(
    "typing_runes_v4",
    51,
    120,
    false,
    50,
    Array.from({ length: 3 }, () => [
      150, 130, 110, 100, 90, 85, 80, 85, 120, 100, 100, 105, 115, 130, 150, 170, 220,
    ]).flat(),
  ),
  typing_portal_exit: kc("typing_portal_exit", 6, 120, false, 5, [160, 140, 125, 110, 95, 90]),
  screen_glance: kc("screen_glance", 13, 230, false, 12),
  scarf_adjust: kc("scarf_adjust", 13, 250, false, 12),
  armcheck_v2: kc("armcheck_v2", 13, 270, false, 12),
  platypus_v2: kc("platypus_v2", 13, 270, false, 12),
  work_enter: kc("work_enter", 13, 210, false, 12),
  work_loop_v2: kc("work_loop_v2", 9, 340, true, 0),
  work_exit: kc("work_exit", 13, 210, false, 12),
  search_v2: kc("search_v2", 13, 250, false, 12),
  success_v2: kc("success_v2", 13, 240, false, 12),
  error_v2: kc("error_v2", 17, 250, false, 16),
  overload_v2: kc("overload_v2", 17, 280, false, 16),
  overload_enter_v3: kc("overload_enter_v3", 17, 230, false, 16, [
    280, 230, 210, 190, 180, 170, 160, 160, 180, 200, 220, 240, 260, 280, 320, 380, 560,
  ]),
  overload_exit_v3: kc("overload_exit_v3", 17, 210, false, 16, [
    360, 300, 270, 240, 220, 200, 190, 180, 170, 170, 180, 190, 210, 230, 260, 300, 420,
  ]),

  rest_enter: kc("rest_enter", 13, 240, false, 12),
  rest_loop_v2: kc("rest_loop_v2", 9, 460, true, 0),

  weapon_draw_sword: kc("weapon_draw_sword", 17, 220, false, 16),
  combat_idle_v2: kc("combat_idle_v2", 9, 360, true, 0),
  combat_grip_v3: kc("combat_grip_v3", 9, 240, false, 8, [300, 230, 210, 200, 280, 210, 220, 250, 360]),
  combat_glance_v3: kc("combat_glance_v3", 9, 250, false, 8, [320, 240, 220, 210, 340, 220, 230, 260, 360]),
  combat_runes_v3: kc("combat_runes_v3", 9, 230, false, 8, [280, 220, 200, 190, 300, 200, 210, 240, 360]),
  streak_v2: kc("streak_v2", 13, 190, false, 12),
  fullweapon_v2: kc("fullweapon_v2", 17, 250, false, 16),

  watch_enter: kc("watch_enter", 13, 230, false, 12),
  watch_loop_v2: kc("watch_loop_v2", 9, 440, true, 0),
  watch_enter_v3: kc("watch_enter_v3", 13, 230, false, 12),
  watch_loop_v3: kc("watch_loop_v3", 9, 440, true, 0),

  night_enter_v2: kc("night_enter_v2", 13, 260, false, 12),
  night_loop_v2: kc("night_loop_v2", 9, 500, true, 0),
  night_glance_v2: kc("night_glance_v2", 13, 240, false, 12),
  night_enter_v3: kc("night_enter_v3", 17, 250, false, 16, [
    300, 260, 240, 230, 220, 210, 210, 220, 230, 240, 250, 260, 280, 300, 340, 380, 520,
  ]),
  night_loop_v3: kc("night_loop_v3", 9, 520, true, 0, [560, 500, 480, 520, 620, 520, 480, 500, 560]),
  night_glance_v3: kc("night_glance_v3", 9, 300, false, 8, [360, 280, 260, 280, 480, 280, 260, 300, 420]),

  leave_v2: kc("leave_v2", 17, 230, false, 16),
  return_v2: kc("return_v2", 17, 230, false, 16),

  swordplant_enter_v3: kc("swordplant_enter_v3", 21, 220, false, 20, [
    280, 230, 210, 200, 190, 190, 200, 210, 220, 240, 260, 300, 360,
    240, 220, 210, 220, 240, 280, 340, 560,
  ]),
  swordplant_hold_v3: kc("swordplant_hold_v3", 9, 500, true, 0, [560, 480, 460, 500, 600, 500, 460, 480, 560]),

  voidstitch_alarm: kc("voidstitch_alarm", 13, 240, false, 12),
  voidstitch_pull: kc("voidstitch_pull", 17, 230, false, 16),
  voidstitch_seal: kc("voidstitch_seal", 17, 250, false, 16),

  // Legacy v1 clips remain catalogued while the visual review is in progress;
  // runtime paths below use only the connected v2 set.
  idle: kc("idle", 9, 360, true, 0, [420, 300, 320, 420, 520, 340, 320, 360, 560]),
  armcheck: kc("armcheck", 9, 230, false, 8, [260, 210, 210, 240, 380, 260, 220, 240, 420]),
  platypus: kc("platypus", 9, 240, false, 8, [280, 220, 220, 260, 320, 280, 240, 260, 520]),
  work: kc("work", 9, 280, true, 0, [320, 260, 260, 300, 340, 280, 260, 300, 380]),
  repair: kc("repair", 9, 300, true, 0, [360, 280, 260, 300, 380, 300, 280, 320, 420]),
  search: kc("search", 9, 250, false, 8, [260, 220, 220, 260, 320, 300, 260, 280, 460]),

  success: kc("success", 9, 220, false, 8, [260, 200, 200, 230, 300, 260, 220, 240, 420]),
  streak: kc("streak", 9, 170, false, 8, [210, 150, 140, 160, 190, 170, 180, 200, 360]),
  error: kc("error", 9, 230, false, 8, [260, 210, 190, 220, 300, 260, 230, 260, 460]),
  overload: kc("overload", 9, 340, false, 8, [420, 260, 300, 460, 520, 380, 320, 360, 700]),

  game_ready: kc("game_ready", 9, 220, false, 8, [280, 220, 200, 220, 280, 260, 240, 280, 520]),
  huntloop: kc("huntloop", 9, 260, true, 0, [320, 240, 240, 280, 340, 260, 240, 280, 380]),
  fullweapon: kc("fullweapon", 9, 300, false, 8, [360, 260, 260, 320, 460, 360, 300, 360, 760]),

  watchturn: kc("watchturn", 9, 260, false, 8, [280, 240, 240, 280, 340, 320, 300, 340, 620]),
  watchloop: kc("watchloop", 9, 420, true, 0, [480, 360, 380, 520, 460, 380, 360, 420, 560]),
  rest: kc("rest", 9, 320, false, 8, [360, 280, 300, 380, 460, 360, 320, 360, 700]),
  leave: kc("leave", 9, 260, false, 8, [280, 240, 240, 300, 360, 320, 280, 320, 520]),
  return: kc("return", 9, 260, false, 8, [300, 260, 240, 260, 320, 300, 260, 320, 560]),

  night_enter: kc("night_enter", 9, 330, false, 8, [380, 300, 300, 360, 460, 380, 340, 380, 760]),
  night_loop: kc("night_loop", 9, 500, true, 0, [560, 460, 480, 620, 560, 480, 460, 520, 700]),
  night_glance: kc("night_glance", 9, 320, false, 8, [380, 280, 280, 340, 460, 360, 320, 360, 680]),
  night_exit: kc("night_exit", 9, 330, false, 8, [420, 320, 300, 340, 420, 360, 320, 360, 700]),

  organ_summon: kc("organ_summon", 9, 320, false, 8, [380, 280, 300, 380, 460, 380, 340, 380, 720]),
  organ_intro: kc("organ_intro", 9, 320, false, 8, [360, 280, 300, 360, 460, 400, 360, 400, 760]),
  organ_play: kc("organ_play", 9, 520, true, 0, [620, 460, 500, 680, 580, 500, 460, 540, 760]),
  organ_memory: kc("organ_memory", 9, 460, false, 8, [520, 420, 440, 560, 640, 520, 460, 520, 860]),
  organ_platypus: kc("organ_platypus", 9, 360, false, 8, [420, 320, 300, 380, 520, 420, 360, 420, 760]),
  organ_finale: kc("organ_finale", 9, 480, false, 8, [560, 420, 460, 640, 720, 560, 500, 560, 980]),
  organ_fade: kc("organ_fade", 9, 420, false, 8, [500, 380, 400, 520, 620, 500, 440, 500, 900]),

  // Connected 47-second organ film. The living poses loop; every transition
  // totals exactly the soundtrack segment it owns, so no final frame freezes.
  organ_sense_v2: kc(
    "organ_sense_v2",
    9,
    280,
    true,
    1,
    [300, 260, 260, 300, 340, 280, 260, 280, 220],
  ),
  organ_summon_v2: kc(
    "organ_summon_v2",
    13,
    460,
    false,
    12,
    [420, 400, 420, 440, 440, 460, 460, 480, 480, 500, 500, 520, 480],
  ),
  organ_play_v2: kc(
    "organ_play_v2",
    9,
    280,
    true,
    1,
    [280, 260, 260, 280, 320, 280, 260, 280, 280],
  ),
  organ_memory_v3: kc("organ_memory_v3", 13, 600, false, 12, [
    600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 800,
  ]),
  organ_platypus_v2: kc(
    "organ_platypus_v2",
    9,
    440,
    false,
    8,
    [420, 420, 420, 460, 520, 460, 420, 420, 460],
  ),
  organ_fade_v2: kc(
    "organ_fade_v2",
    9,
    440,
    false,
    8,
    [420, 420, 420, 460, 520, 460, 420, 420, 460],
  ),
  // Connected fade: the organ dissolves behind an always-visible Kael, then
  // he transfers his weight and rises into the exact base idle pose.
  organ_fade_v3: kc(
    "organ_fade_v3",
    13,
    320,
    false,
    12,
    [300, 300, 300, 320, 320, 320, 320, 340, 340, 320, 300, 300, 220],
  ),

  voidstitch: kc("voidstitch", 9, 360, false, 8, [420, 300, 320, 420, 560, 460, 380, 460, 900]),
};

export function kaelClipTotal(c: CorvinClip): number {
  return (c.msSeq ?? Array(c.frames.length).fill(c.ms)).reduce((a, b) => a + b, 0);
}
