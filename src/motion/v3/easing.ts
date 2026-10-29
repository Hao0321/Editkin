/** Motion curves for Motion Design v3. Entrances decelerate hard (expo/quint out),
 * exits accelerate (cubic in), so elements arrive with intent and leave quietly. */
export const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
export const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

export const easeOutCubic = (t: number): number => 1 - (1 - clamp01(t)) ** 3;
export const easeOutQuint = (t: number): number => 1 - (1 - clamp01(t)) ** 5;
export const easeOutExpo = (t: number): number => (t >= 1 ? 1 : 1 - 2 ** (-10 * clamp01(t)));
export const easeInCubic = (t: number): number => clamp01(t) ** 3;
export const easeInOutCubic = (t: number): number => {
  const x = clamp01(t);
  return x < .5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2;
};
/** Overshoot then settle; `overshoot` 1.7 is the classic back curve. */
export const easeOutBack = (t: number, overshoot = 1.7): number => {
  const x = clamp01(t) - 1;
  return 1 + (overshoot + 1) * x ** 3 + overshoot * x ** 2;
};

/** Frames at 30 fps scaled to the project rate, so timing feels identical at 24/25/60 fps. */
export function frames(count: number, fps: number): number {
  return Math.max(1, Math.round(count * fps / 30));
}

/** Linear progress of a phase that starts at `delay` and lasts `duration` frames. */
export function phase(localFrame: number, delay: number, duration: number): number {
  return clamp01((localFrame - delay) / Math.max(1, duration));
}

/**
 * One element's choreography: `enter` rises 0→1 after `delay`, `exit` rises 0→1 in
 * the last frames. `exitLead` starts an element's exit earlier; give later elements
 * a larger lead so exits run in reverse order.
 */
export function beat(localFrame: number, total: number, fps: number, options: {
  delay?: number; enter?: number; exit?: number; exitLead?: number;
  enterEase?: (t: number) => number; exitEase?: (t: number) => number;
} = {}) {
  const delay = frames(options.delay ?? 0, fps);
  const enterFrames = frames(options.enter ?? 18, fps);
  const exitFrames = frames(options.exit ?? 10, fps);
  // Exits finish on the last frame, so a graphic never cuts off mid-move.
  const exitStart = total - 1 - exitFrames - frames(options.exitLead ?? 0, fps);
  const enterRaw = phase(localFrame, delay, enterFrames);
  const exitRaw = phase(localFrame, exitStart, exitFrames);
  return {
    enter: (options.enterEase ?? easeOutExpo)(enterRaw),
    exit: (options.exitEase ?? easeInCubic)(exitRaw),
    enterRaw,
    exitRaw,
    visible: localFrame >= delay && exitRaw < 1,
  };
}
