// Режиссёр — локальный мозг Корвина (никакого API, никакой сети, для всех).
//
// Вместо жёсткого «в 15:00 играем charge» он раз в 20-45 секунд спрашивает:
// что сейчас УМЕСТНО? Каждый кандидат получает балл из трёх слагаемых:
//
//   балл = база(ситуация) * усталость(давно ли играл) * вес(обучение)
//
//   база       — насколько действие подходит вектору момента (ночь, работа,
//                серия ошибок, ты за машиной или ушёл);
//   усталость  — только что сыгранное почти обнуляется и восстанавливается
//                со временем: повторов подряд не бывает по построению;
//   вес        — память о твоей реакции: продолжил работать после сцены —
//                действию плюс, свернул окно/задёргал мышью — минус.
//                Живёт в story.json, переживает перезапуски.
//
// Ритуалы (полночь, реквием, 01:00/13:00, Steam-биты, дневные часы) остаются
// жёсткими — режиссёр распоряжается только свободным временем между ними.

export interface Situation {
  hour: number; // 0-23
  workMinutes: number; // сколько подряд идёт AI-сессия
  typing: boolean; // пользователь печатает прямо сейчас
  present: boolean; // был активен за последние 5 минут
  gaming: boolean;
  errStreak: number;
  winStreak: number;
  sinceSceneSec: number; // сколько прошло от последней большой сцены
}

export interface DirectorAction {
  id: string;
  // big — полноценная сцена (уважает sceneAllowed); small — связка/микро,
  // можно часто; pose — смена базовой позы.
  kind: "big" | "small" | "pose";
  cooldownSec: number; // личное «не чаще, чем»
  base: (s: Situation) => number; // 0 = нельзя сейчас, 1 = обычно, >1 = самое время
  // Planned actions are dispatched by an absolute character clock. They stay
  // in the catalogue so Director owns gating, history and feedback, but never
  // enter the weighted ambient lottery.
  planned?: boolean;
  // The dispatcher must establish this physical pose before frame zero. This
  // prevents a valid timed action from teleporting between seated and standing
  // silhouettes just because Director selected it at an awkward moment.
  posture?: "seated" | "standing";
}

const night = (s: Situation) => s.hour >= 22 || s.hour < 6;
const evening = (s: Situation) => s.hour >= 18 && s.hour < 22;

// Каталог решений. base возвращает 0, когда действие сейчас неуместно.
export const ACTIONS: DirectorAction[] = [
  // --- микрореакции: дёшево, оживляют паузы, почти всегда уместны ---
  { id: "flinch", kind: "small", cooldownSec: 480, base: (s) => (s.errStreak > 0 ? 1.6 : 0.5) },
  { id: "coatdust", kind: "small", cooldownSec: 420, base: () => 1 },
  { id: "nodself", kind: "small", cooldownSec: 360, base: (s) => (s.winStreak > 0 ? 1.5 : 0.8) },
  { id: "lookarm", kind: "small", cooldownSec: 600, base: (s) => (s.errStreak > 1 ? 1.8 : night(s) ? 1.3 : 0.7) },
  { id: "breathfog", kind: "small", cooldownSec: 540, base: (s) => (night(s) ? 1.6 : 0.6) },
  { id: "knuckle", kind: "small", cooldownSec: 480, base: (s) => (s.gaming ? 1.6 : 0.9) },
  { id: "eaglelook", kind: "small", cooldownSec: 540, base: () => 1.1 },
  { id: "hairwind", kind: "small", cooldownSec: 600, base: () => 0.9 },
  // --- связки и смены позы: ткань между сценами ---
  { id: "shiftweight", kind: "small", cooldownSec: 240, base: () => 1.2 },
  { id: "glanceback", kind: "small", cooldownSec: 420, base: (s) => (night(s) ? 1.5 : 1) },
  { id: "stepright", kind: "pose", cooldownSec: 600, base: (s) => (s.present ? 1 : 0.4) },
  { id: "turnpair", kind: "pose", cooldownSec: 720, base: () => 0.9 }, // туда и обратно
  { id: "leanspell", kind: "pose", cooldownSec: 900, base: (s) => (s.workMinutes > 30 ? 1.4 : 0.8) },
  { id: "crouchcheck", kind: "small", cooldownSec: 700, base: (s) => (s.gaming ? 1.5 : 0.8) },
  { id: "swordcarry", kind: "pose", cooldownSec: 900, base: () => 0.9 }, // на плечо и обратно
  { id: "swordrest", kind: "big", cooldownSec: 3600, base: (s) => (s.typing ? 0 : s.sinceSceneSec > 900 ? 0.85 : 0.35) },
  { id: "stretch2", kind: "small", cooldownSec: 800, base: (s) => (s.workMinutes > 45 ? 1.7 : 0.7) },
  { id: "crouchrest", kind: "pose", cooldownSec: 1100, base: (s) => (s.workMinutes > 60 ? 1.4 : 0.6) },
  // --- быт: низкая энергия, тихие часы ---
  { id: "feedeagle", kind: "big", cooldownSec: 2400, base: (s) => (s.present ? 1.1 : 0.5) },
  { id: "flask", kind: "big", cooldownSec: 2100, base: (s) => (s.workMinutes > 40 ? 1.3 : 0.8) },
  // the stone lean: a resting beat for quiet stretches — never while you type
  { id: "leanstone", kind: "big", cooldownSec: 1800, base: (s) => (s.typing ? 0.2 : s.sinceSceneSec > 600 ? 1.4 : 0.9) },
  // the cairn rest (user-directed): sits on the ground against the stones and
  // stays a while — an evening/night beat for long quiet stretches
  { id: "stonerest", kind: "big", cooldownSec: 10800, base: (s) => (s.typing ? 0 : s.hour >= 17 || s.hour < 2 ? 1.5 : 0.6) },
  { id: "sleep", kind: "big", cooldownSec: 5400, base: (s) => (!s.present && night(s) ? 2.5 : !s.present ? 1 : 0) },
  // --- существующие сцены: теперь и они в конкурсе ---
  { id: "tale", kind: "big", cooldownSec: 1500, base: (s) => (evening(s) || night(s) ? 1.5 : 0.9) },
  { id: "aura", kind: "big", cooldownSec: 2000, base: (s) => (night(s) ? 1.4 : 0.8) },
  { id: "scan", kind: "big", cooldownSec: 1400, base: (s) => (s.hour >= 8 && s.hour < 18 ? 1.3 : 0.8) },
  { id: "artsiv", kind: "big", cooldownSec: 2200, base: (s) => (s.present ? 1.2 : 0.6) },
  { id: "bow", kind: "big", cooldownSec: 3600, base: () => 0.5 },
  { id: "road", kind: "big", cooldownSec: 2600, base: (s) => (evening(s) || night(s) ? 1.3 : 0.6) },
  // THE DOOR: the headline fight — rare, evening-leaning, only for a present
  // viewer. The scene itself enforces a 4h floor on top of this cooldown.
  { id: "door", kind: "big", cooldownSec: 6 * 3600, base: (s) => (!s.present || s.typing ? 0 : evening(s) || night(s) ? 1.2 : 0.6) },
  { id: "rain", kind: "big", cooldownSec: 3200, base: (s) => (night(s) ? 1.1 : 0.5) },
];

export const CORVIN_HARD_PLAN_CYCLE_SEC = 3 * 60 * 60;
export const CORVIN_HARD_PLAN: DirectorPlanBeat[] = [
  { id: "shiftweight", atSec: 3 * 60 },
  { id: "coatdust", atSec: 8 * 60 },
  { id: "glanceback", atSec: 13 * 60 },
  { id: "eaglelook", atSec: 18 * 60 },
  { id: "hairwind", atSec: 23 * 60 },
  { id: "flinch", atSec: 28 * 60 },
  { id: "nodself", atSec: 33 * 60 },
  { id: "lookarm", atSec: 38 * 60 },
  { id: "breathfog", atSec: 43 * 60 },
  { id: "knuckle", atSec: 48 * 60 },
  { id: "stepright", atSec: 54 * 60 },
  { id: "crouchcheck", atSec: 60 * 60 },
  { id: "stretch2", atSec: 66 * 60 },
  { id: "crouchrest", atSec: 72 * 60 },
  { id: "turnpair", atSec: 80 * 60 },
  { id: "leanspell", atSec: 88 * 60 },
  { id: "swordcarry", atSec: 98 * 60 },
  { id: "swordrest", atSec: 110 * 60 },
  { id: "feedeagle", atSec: 124 * 60 },
  { id: "leanstone", atSec: 136 * 60 },
  { id: "tale", atSec: 148 * 60 },
  { id: "aura", atSec: 158 * 60 },
  { id: "road", atSec: 166 * 60 },
  { id: "rain", atSec: 172 * 60 },
  { id: "stonerest", atSec: 178 * 60 },
];

const corvinHardActionIds = new Set(CORVIN_HARD_PLAN.map((beat) => beat.id));
for (const action of ACTIONS) {
  if (corvinHardActionIds.has(action.id)) action.planned = true;
  action.posture = "standing";
}

// Dante has his own repertoire and memory. His director favours small lived-in
// beats, with the headline scenes kept rare; fixed daily/game clocks still own
// their exact appointments.
export const DANTE_HARD_PLAN_CYCLE_SEC = 4 * 60 * 60;
export const DANTE_HARD_PLAN: DirectorPlanBeat[] = [
  { id: "d_glanceover", atSec: 3 * 60 },
  { id: "sitswing", atSec: 8 * 60 },
  { id: "d_bootswing", atSec: 13 * 60 },
  { id: "headtilt", atSec: 18 * 60 },
  { id: "d_neckroll", atSec: 23 * 60 },
  { id: "checkwatch", atSec: 28 * 60 },
  { id: "d_jacketflick", atSec: 33 * 60 },
  { id: "stretch", atSec: 38 * 60 },
  { id: "d_knuckles", atSec: 43 * 60 },
  // d_coffee carries `planned: true` in the catalogue but had no slot here, and
  // pick() skips every planned action — so it was selectable by neither path.
  // 11 frames of art that could never appear. It sits among the other seated
  // micros, and its own dispatch guard keeps it to waking hours (10:00-20:00).
  { id: "d_coffee", atSec: 46 * 60 },
  { id: "leanback", atSec: 48 * 60 },
  { id: "d_crouchpeer", atSec: 53 * 60 },
  { id: "laugh", atSec: 58 * 60 },
  { id: "d_hairswipe", atSec: 63 * 60 },
  { id: "cleansword", atSec: 68 * 60 },
  { id: "d_sigh", atSec: 73 * 60 },
  { id: "cheer", atSec: 78 * 60 },
  { id: "d_sitedge", atSec: 83 * 60 },
  { id: "yawn", atSec: 88 * 60 },
  { id: "d_phone", atSec: 93 * 60 },
  { id: "shrug", atSec: 98 * 60 },
  { id: "d_standlean", atSec: 103 * 60 },
  { id: "sitthink", atSec: 108 * 60 },
  { id: "d_fingerguns", atSec: 113 * 60 },
  { id: "coin", atSec: 118 * 60 },
  { id: "nap", atSec: 123 * 60 },
  { id: "gunspin", atSec: 128 * 60 },
  { id: "d_layback", atSec: 133 * 60 },
  { id: "lookout", atSec: 138 * 60 },
  { id: "taunt", atSec: 143 * 60 },
  { id: "sitcross", atSec: 148 * 60 },
  { id: "standcross", atSec: 153 * 60 },
  { id: "swordspin", atSec: 158 * 60 },
  { id: "pizza", atSec: 163 * 60 },
  { id: "shoot", atSec: 169 * 60 },
  { id: "stagger", atSec: 175 * 60 },
  { id: "dance", atSec: 181 * 60 },
  { id: "dive", atSec: 188 * 60 },
  { id: "headbang", atSec: 196 * 60 },
  { id: "swordmove", atSec: 204 * 60 },
  { id: "deviltrigger", atSec: 212 * 60 },
  { id: "devilform", atSec: 222 * 60 },
  { id: "moto", atSec: 234 * 60 },
];

export const DANTE_ACTIONS: DirectorAction[] = [
  { id: "d_glanceover", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "d_bootswing", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "d_neckroll", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "d_jacketflick", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "d_knuckles", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "d_hairswipe", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "d_sigh", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "d_sitedge", kind: "pose", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "d_phone", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "d_fingerguns", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "d_coffee", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "d_layback", kind: "pose", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "d_standlean", kind: "pose", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "d_crouchpeer", kind: "pose", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "sitswing", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "sitcross", kind: "pose", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "sitthink", kind: "pose", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "leanback", kind: "pose", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "laugh", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "checkwatch", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "yawn", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "nap", kind: "pose", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "stretch", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "shrug", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "headtilt", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "lookout", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "cleansword", kind: "pose", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "coin", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "swordspin", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "pizza", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "dance", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "headbang", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "deviltrigger", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "devilform", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "moto", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "dive", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "shoot", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "gunspin", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "taunt", kind: "pose", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "cheer", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "stagger", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "standcross", kind: "pose", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "swordmove", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
];
const danteSeatedActionIds = new Set([
  "sitswing",
  "sitcross",
  "sitthink",
  "leanback",
  "laugh",
  "checkwatch",
  "yawn",
  "nap",
  "stretch",
  "shrug",
  "headtilt",
  "lookout",
  "cleansword",
  "d_glanceover",
  "d_bootswing",
  "d_neckroll",
  "d_jacketflick",
  "d_knuckles",
  "d_hairswipe",
  "d_sigh",
  "d_sitedge",
  "d_phone",
  "d_fingerguns",
  "d_coffee",
  "d_layback",
  "pizza",
]);
const danteHardActionIds = new Set(DANTE_HARD_PLAN.map((beat) => beat.id));
for (const action of DANTE_ACTIONS) {
  if (danteHardActionIds.has(action.id)) action.planned = true;
  action.posture = danteSeatedActionIds.has(action.id) ? "seated" : "standing";
}

export interface DirectorPlanBeat {
  id: string;
  atSec: number;
}

// Kael's living animation is deliberately clocked, not random. Every ordinary
// micro/pose gets a guaranteed slot in this 90-minute reel. The rare narrative
// scenes keep their explicit hotkey/error/night routes below the reel, while
// the three-minute sword rest has a clean ending before the next beat.
export const KAEL_HARD_PLAN_CYCLE_SEC = 90 * 60;
export const KAEL_HARD_PLAN: DirectorPlanBeat[] = [
  { id: "cloaksettle", atSec: 3 * 60 },
  { id: "razlomtap", atSec: 8 * 60 },
  { id: "platypus_sniff", atSec: 14 * 60 },
  { id: "armcheck", atSec: 21 * 60 },
  { id: "scarf", atSec: 29 * 60 },
  { id: "platypus", atSec: 38 * 60 },
  { id: "repair", atSec: 48 * 60 },
  { id: "cloaksettle", atSec: 58 * 60 },
  { id: "razlomtap", atSec: 65 * 60 },
  { id: "platypus_sniff", atSec: 72 * 60 },
  { id: "swordplant", atSec: 78 * 60 },
  { id: "rest", atSec: 86 * 60 },
];

export const KAEL_ACTIONS: DirectorAction[] = [
  { id: "cloaksettle", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? (s.present ? 1 : 0.45) : 0) },
  { id: "razlomtap", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? (s.present ? 0.9 : 0.35) : 0) },
  { id: "swordplant", kind: "big", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && s.sinceSceneSec > 1200 ? 1 : 0) },
  { id: "platypus_sniff", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? (s.present ? 0.9 : 0.35) : 0) },
  { id: "armcheck", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "platypus", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "scarf", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "repair", kind: "pose", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "rest", kind: "big", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && s.sinceSceneSec > 900 ? 1 : 0) },
  { id: "voidorgan", kind: "big", cooldownSec: 4 * 24 * 3600, base: (s) => (!s.typing && !s.gaming && s.present && (evening(s) || night(s)) ? 1.25 : 0) },
  { id: "voidstitch", kind: "big", cooldownSec: 12 * 3600, base: (s) => (!s.typing && s.present && (s.errStreak > 1 || night(s)) ? 0.75 : 0) },
];
for (const action of KAEL_ACTIONS) action.posture = "standing";

export interface DirectorState {
  weights: Record<string, number>; // обучение: 0.3 .. 2.5
  lastPlayed: Record<string, number>; // когда действие играло в последний раз
}

export class Director {
  st: DirectorState;
  private readonly actions: DirectorAction[];
  // Which planned actions already used their one allowed skip. In-memory on
  // purpose: a restart must not let an action defer twice running.
  private readonly deferred = new Set<string>();

  constructor(saved?: Partial<DirectorState>, actions: DirectorAction[] = ACTIONS) {
    this.st = { weights: {}, lastPlayed: {}, ...saved };
    this.actions = actions;
  }

  // Выбор следующего действия. null — сейчас лучше ничего не делать.
  pick(s: Situation, allowBig: boolean): DirectorAction | null {
    const now = Date.now();
    let total = 0;
    const scored: Array<[DirectorAction, number]> = [];
    for (const a of this.actions) {
      if (a.planned) continue;
      if (a.kind === "big" && !allowBig) continue;
      const last = this.st.lastPlayed[a.id] ?? 0;
      const since = (now - last) / 1000;
      if (since < a.cooldownSec) continue; // личный кулдаун — жёсткий
      const base = a.base(s);
      if (base <= 0) continue;
      // усталость восстанавливается ещё два кулдауна после минимума
      const fresh = Math.min(1, (since - a.cooldownSec) / (a.cooldownSec * 2) + 0.35);
      const w = this.st.weights[a.id] ?? 1;
      const score = base * fresh * w;
      scored.push([a, score]);
      total += score;
    }
    if (!scored.length || total <= 0) return null;
    // Иногда честно молчать: тишина — тоже выбор режиссёра.
    const silence = s.typing ? total * 1.2 : total * 0.35;
    let r = Math.random() * (total + silence);
    if (r >= total) return null;
    for (const [a, sc] of scored) {
      r -= sc;
      if (r <= 0) {
        this.st.lastPlayed[a.id] = now;
        return a;
      }
    }
    // float-edge fallback — must stamp the cooldown like every other pick
    const last = scored[scored.length - 1][0];
    this.st.lastPlayed[last.id] = now;
    return last;
  }

  // Hard-plan dispatch still passes through Director: situational vetoes,
  // last-played history and feedback remain character-specific. The plan itself
  // is the cooldown, so no secondary cooldown is applied.
  takePlanned(id: string, s: Situation, allowBig: boolean): DirectorAction | null {
    const action = this.actions.find((candidate) => candidate.id === id && candidate.planned);
    if (!action || (action.kind === "big" && !allowBig) || action.base(s) <= 0) return null;
    // Learning applies here too. Every one of Dante's 43 actions is planned, so
    // with the weight ignored his `feedback()` wrote to story.json and nothing
    // ever read it back — the pack looked like it learned and did not.
    //
    // A low weight may only THIN a beat, never silence it: the skip happens at
    // most once in a row per action, so the worst a disliked scene suffers is
    // appearing every second cycle. Coverage stays guaranteed, which is the
    // whole point of the hard plan.
    const w = this.st.weights[action.id] ?? 1;
    if (w < 1 && !this.deferred.has(action.id) && Math.random() > w) {
      this.deferred.add(action.id);
      return null;
    }
    this.deferred.delete(action.id);
    this.st.lastPlayed[action.id] = Date.now();
    return action;
  }

  // Обучение: ok=true — пользователь спокойно продолжил (сцена уместна),
  // ok=false — свернул/задёргал (сцена помешала).
  feedback(id: string, ok: boolean): void {
    const w = this.st.weights[id] ?? 1;
    this.st.weights[id] = Math.min(2.5, Math.max(0.3, w + (ok ? 0.06 : -0.18)));
  }
}
