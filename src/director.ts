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
  // Играет музыка. Крупные сцены под неё не выходят — он слушает вместе с
  // тобой, а не перетягивает внимание.
  music: boolean;
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


// ---- Часовые корзины -------------------------------------------------------
// План строится ЧАСАМИ, а не одной лентой. Плоский список выдавал бит ровно
// каждые пять минут в одном и том же порядке — метроном, а не жизнь, и поза
// прыгала: стоячее движение оказывалось между двумя сидячими, он вставал ради
// одного жеста и садился обратно.
//
// Час = сидячий блок -> ОДИН подъём -> крупная сцена со стоячими жестами ->
// ОДНА посадка -> сидячий блок. Два перехода позы за час вместо десяти.
//
// Ровно одна крупная сцена в час, и каждый час другая: круг не повторяется,
// пока не пройдёт весь список. Микро-жесты повторяются между часами намеренно —
// это «он жив», а не событие.
export interface PlanHour {
  big: string;
  seatedOpen: string[];
  standing: string[];
  seatedClose: string[];
}

// Промежутки внутри часа разные — 4, 7, 9, 6, 11, 8 — чтобы биты не ложились
// на одинаковую сетку. Три набора чередуются по часам.
const GAP_PATTERNS = [
  [4, 11, 19, 27, 34, 41, 47, 53],
  [6, 13, 21, 30, 38, 45, 51, 57],
  [5, 12, 18, 26, 35, 43, 50, 56],
];

function buildHourPlan(hours: PlanHour[]): DirectorPlanBeat[] {
  const out: DirectorPlanBeat[] = [];
  hours.forEach((hour, index) => {
    const order = [...hour.seatedOpen, hour.big, ...hour.standing, ...hour.seatedClose];
    const gaps = GAP_PATTERNS[index % GAP_PATTERNS.length];
    order.forEach((id, slot) => {
      const minute = gaps[slot] ?? gaps[gaps.length - 1] + (slot - gaps.length + 1) * 2;
      out.push({ id, atSec: index * 3600 + minute * 60 });
    });
  });
  return out;
}

export const CORVIN_PLAN_HOURS: PlanHour[] = [
  { big: "swordrest",  seatedOpen: ["shiftweight", "glanceback", "breathfog"], standing: ["crouchcheck"], seatedClose: ["coatdust", "nodself"] },
  { big: "tale",       seatedOpen: ["hairwind", "lookarm", "knuckle"],         standing: ["stretch2"],    seatedClose: ["glanceback", "flinch"] },
  { big: "aura",       seatedOpen: ["coatdust", "shiftweight", "nodself"],     standing: ["turnpair"],    seatedClose: ["eaglelook", "breathfog"] },
  { big: "road",       seatedOpen: ["glanceback", "hairwind", "flinch"],       standing: ["stepright"],   seatedClose: ["knuckle", "lookarm"] },
  { big: "rain",       seatedOpen: ["shiftweight", "eaglelook", "coatdust"],   standing: ["crouchrest"],  seatedClose: ["nodself", "hairwind"] },
  { big: "stonerest",  seatedOpen: ["breathfog", "glanceback", "knuckle"],     standing: ["leanspell"],   seatedClose: ["flinch", "shiftweight"] },
  { big: "feedeagle",  seatedOpen: ["lookarm", "coatdust", "eaglelook"],       standing: ["swordcarry"],  seatedClose: ["nodself", "breathfog"] },
  { big: "leanstone",  seatedOpen: ["hairwind", "shiftweight", "glanceback"],  standing: ["crouchcheck"], seatedClose: ["knuckle", "flinch"] },
];

export const CORVIN_HARD_PLAN_CYCLE_SEC = CORVIN_PLAN_HOURS.length * 3600;
export const CORVIN_HARD_PLAN: DirectorPlanBeat[] = buildHourPlan(CORVIN_PLAN_HOURS);

// Всё, что стоит в часовых корзинах, уходит из лотереи: расписание им и есть
// кулдаун. Шесть остальных (flask, sleep, scan, artsiv, bow, door) живут на
// своих поводах — суточный час или событие, — и в план намеренно не входят.
const corvinHardActionIds = new Set(CORVIN_HARD_PLAN.map((beat) => beat.id));
for (const action of ACTIONS) {
  if (corvinHardActionIds.has(action.id)) action.planned = true;
  // Корвин не садится: все его сцены поставлены от стойки.
  action.posture = "standing";
}

export const DANTE_PLAN_HOURS: PlanHour[] = [
  { big: "moto",        seatedOpen: ["d_glanceover", "d_neckroll", "sitswing"],   standing: ["d_standlean"],  seatedClose: ["d_jacketflick", "leanback"] },
  { big: "dance",       seatedOpen: ["d_hairswipe", "headtilt", "sitthink"],      standing: ["coin"],         seatedClose: ["shrug", "d_sitedge"] },
  { big: "deviltrigger",seatedOpen: ["d_knuckles", "d_sigh", "checkwatch"],       standing: ["gunspin"],      seatedClose: ["d_glanceover", "d_phone"] },
  { big: "swordmove",   seatedOpen: ["d_neckroll", "d_jacketflick", "sitcross"],  standing: ["taunt"],        seatedClose: ["headtilt", "d_fingerguns"] },
  { big: "pizza",       seatedOpen: ["d_hairswipe", "shrug", "stretch"],          standing: ["swordspin"],    seatedClose: ["d_sigh", "d_bootswing"] },
  { big: "headbang",    seatedOpen: ["d_knuckles", "d_glanceover", "laugh"],      standing: ["cheer"],        seatedClose: ["d_neckroll", "lookout"] },
  { big: "dive",        seatedOpen: ["headtilt", "d_jacketflick", "yawn"],        standing: ["stagger"],      seatedClose: ["d_hairswipe", "d_layback"] },
  { big: "devilform",   seatedOpen: ["d_sigh", "shrug", "cleansword"],            standing: ["standcross", "d_crouchpeer"], seatedClose: ["d_knuckles", "nap"] },
  { big: "shoot",       seatedOpen: ["d_glanceover", "headtilt", "d_coffee"],     standing: ["d_standlean"],  seatedClose: ["d_neckroll", "d_bootswing"] },
];

export const DANTE_HARD_PLAN_CYCLE_SEC = DANTE_PLAN_HOURS.length * 3600;
export const DANTE_HARD_PLAN: DirectorPlanBeat[] = buildHourPlan(DANTE_PLAN_HOURS);

export const DANTE_ACTIONS: DirectorAction[] = [
  { id: "d_glanceover", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "d_bootswing", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "d_neckroll", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "d_jacketflick", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "d_knuckles", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "d_hairswipe", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "d_sigh", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "d_sitedge", kind: "pose", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "d_phone", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "d_fingerguns", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "d_coffee", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "d_layback", kind: "pose", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "d_standlean", kind: "pose", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "d_crouchpeer", kind: "pose", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "sitswing", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "sitcross", kind: "pose", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "sitthink", kind: "pose", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "leanback", kind: "pose", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "laugh", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "checkwatch", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "yawn", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  // Спать — только глубокой ночью, после ночной стражи 00:40 и до 05:00
  // (user-directed). Общее условие позволяло заснуть в 14:00.
  { id: "nap", kind: "pose", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music && s.hour >= 0 && s.hour < 5 ? 1 : 0) },
  { id: "stretch", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "shrug", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "headtilt", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "lookout", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "cleansword", kind: "pose", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "coin", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "swordspin", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "pizza", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "dance", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "headbang", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "deviltrigger", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "devilform", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  // Мото — единственная крупная, которую музыка НЕ глушит (user-directed):
  // ехать под трек это и есть быть с тобой в теме, а не перебивать её.
  { id: "moto", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming ? 1 : 0) },
  { id: "dive", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "shoot", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "gunspin", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "taunt", kind: "pose", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "cheer", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "stagger", kind: "small", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "standcross", kind: "pose", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "swordmove", kind: "big", cooldownSec: 0, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
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
  { id: "armcheck", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "platypus", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "scarf", kind: "small", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
  { id: "repair", kind: "pose", cooldownSec: 0, planned: true, base: (s) => (!s.typing && !s.gaming && !s.music ? 1 : 0) },
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
    // NO WEIGHT, NO DICE (user-directed). A scheduled beat is scheduled: the only
    // things that may stop it are the situational veto above (`base(s) <= 0` —
    // wrong hour, typing, mid-game) and the big-scene gap.
    //
    // A learned weight was briefly consulted here so that Dante's feedback()
    // stopped writing to state nothing read. That was the wrong trade: every one
    // of his actions is planned, so the weight put a lottery back inside the one
    // mechanism that exists to remove it, and a scene could silently sit out its
    // slot. Guaranteed coverage is the point — an unreachable scene is a scene
    // that may as well not have been drawn. Learning stays where randomness is
    // already allowed: pick(), the ambient path.
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
