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
  { id: "stretch2", kind: "small", cooldownSec: 800, base: (s) => (s.workMinutes > 45 ? 1.7 : 0.7) },
  { id: "crouchrest", kind: "pose", cooldownSec: 1100, base: (s) => (s.workMinutes > 60 ? 1.4 : 0.6) },
  // --- быт: низкая энергия, тихие часы ---
  { id: "feedeagle", kind: "big", cooldownSec: 2400, base: (s) => (s.present ? 1.1 : 0.5) },
  { id: "flask", kind: "big", cooldownSec: 2100, base: (s) => (s.workMinutes > 40 ? 1.3 : 0.8) },
  // the stone lean: a resting beat for quiet stretches — never while you type
  { id: "leanstone", kind: "big", cooldownSec: 1800, base: (s) => (s.typing ? 0.2 : s.sinceSceneSec > 600 ? 1.4 : 0.9) },
  { id: "sleep", kind: "big", cooldownSec: 5400, base: (s) => (!s.present && night(s) ? 2.5 : !s.present ? 1 : 0) },
  // --- существующие сцены: теперь и они в конкурсе ---
  { id: "tale", kind: "big", cooldownSec: 1500, base: (s) => (evening(s) || night(s) ? 1.5 : 0.9) },
  { id: "aura", kind: "big", cooldownSec: 2000, base: (s) => (night(s) ? 1.4 : 0.8) },
  { id: "scan", kind: "big", cooldownSec: 1400, base: (s) => (s.hour >= 8 && s.hour < 18 ? 1.3 : 0.8) },
  { id: "artsiv", kind: "big", cooldownSec: 2200, base: (s) => (s.present ? 1.2 : 0.6) },
  { id: "bow", kind: "big", cooldownSec: 3600, base: () => 0.5 },
  { id: "road", kind: "big", cooldownSec: 2600, base: (s) => (evening(s) || night(s) ? 1.3 : 0.6) },
  { id: "rain", kind: "big", cooldownSec: 3200, base: (s) => (night(s) ? 1.1 : 0.5) },
];

export interface DirectorState {
  weights: Record<string, number>; // обучение: 0.3 .. 2.5
  lastPlayed: Record<string, number>; // когда действие играло в последний раз
}

export class Director {
  st: DirectorState;

  constructor(saved?: Partial<DirectorState>) {
    this.st = { weights: {}, lastPlayed: {}, ...saved };
  }

  // Выбор следующего действия. null — сейчас лучше ничего не делать.
  pick(s: Situation, allowBig: boolean): DirectorAction | null {
    const now = Date.now();
    let total = 0;
    const scored: Array<[DirectorAction, number]> = [];
    for (const a of ACTIONS) {
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
    return scored[scored.length - 1][0];
  }

  // Обучение: ok=true — пользователь спокойно продолжил (сцена уместна),
  // ok=false — свернул/задёргал (сцена помешала).
  feedback(id: string, ok: boolean): void {
    const w = this.st.weights[id] ?? 1;
    this.st.weights[id] = Math.min(2.5, Math.max(0.3, w + (ok ? 0.06 : -0.18)));
  }
}
