import { useEffect, useRef } from "react";

/**
 * The Comet Field — the site's sky. A fixed canvas behind everything:
 * twinkling stars, ambient comet-tabs drifting through, and a small flock of
 * bright ones launched whenever a "tabrunner:launch" CustomEvent fires (the
 * hero's mission line). The pointer leaves a faint ion wake.
 *
 * Every comet head is a tiny browser tab: the product's whole idea in one
 * glyph — so one goal throws a spray of tabs, not a single spark.
 * prefers-reduced-motion gets a static star field, no comets.
 */

const LAUNCH_EVENT = "tabrunner:launch";
/** Tabs per launch: a lead comet plus its rain. */
const BURST = 5;

export function launchComet(origin?: { x: number; y: number }) {
  window.dispatchEvent(new CustomEvent(LAUNCH_EVENT, { detail: origin }));
}

interface Star {
  x: number;
  y: number;
  r: number;
  phase: number;
  speed: number;
}

interface TrailPoint {
  x: number;
  y: number;
  age: number;
}

interface Comet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  bright: boolean;
  trail: TrailPoint[];
}

const ION = { r: 52, g: 211, b: 153 }; // flare-400
const TEL = { r: 251, g: 191, b: 36 }; // tel-400

export function CometField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let raf = 0;
    let last = performance.now();
    let spawnIn = 1200;
    const stars: Star[] = [];
    const comets: Comet[] = [];
    const wake: TrailPoint[] = [];
    /** The launch rain, staggered on the render clock rather than on timers. */
    const queued: Array<{ origin: { x: number; y: number }; in: number }> = [];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars.length = 0;
      const count = Math.round((width * height) / 9000);
      for (let i = 0; i < count; i++) {
        stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          r: Math.random() * 1.1 + 0.3,
          phase: Math.random() * Math.PI * 2,
          speed: 0.4 + Math.random() * 1.2,
        });
      }
      if (reduced) drawStatic();
    };

    const drawStars = (t: number) => {
      for (const s of stars) {
        const twinkle = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(s.phase + t * 0.001 * s.speed));
        ctx.fillStyle = `rgba(232, 238, 251, ${0.55 * twinkle})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const drawStatic = () => {
      ctx.clearRect(0, 0, width, height);
      drawStars(0);
    };

    // The lead comet flies the clean line; the rain fans out and trails behind it.
    const spawnComet = (origin?: { x: number; y: number }, lead = false) => {
      if (comets.length > BURST * 2 + 6) return;
      const bright = Boolean(origin);
      const angle = bright
        ? -Math.PI / 5 + (lead ? 0 : (Math.random() - 0.5) * 0.9) // launched: up and away
        : Math.PI / 7 + (Math.random() - 0.5) * 0.5; // ambient: drifting down-right
      const speed = bright ? (lead ? 620 : 380 + Math.random() * 240) : 200 + Math.random() * 160;
      const spread = bright && !lead ? 26 : 0;
      comets.push({
        x: (origin?.x ?? -40) + (Math.random() - 0.5) * spread,
        y: (origin?.y ?? Math.random() * height * 0.6) + (Math.random() - 0.5) * spread,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: bright ? 2.6 : 3.8,
        size: bright ? (lead ? 1.25 : 0.7 + Math.random() * 0.3) : 0.9,
        bright,
        trail: [],
      });
    };

    const drawTab = (x: number, y: number, angle: number, scale: number, glow: boolean) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.scale(scale, scale);
      if (glow) {
        ctx.shadowColor = `rgba(${ION.r}, ${ION.g}, ${ION.b}, 0.9)`;
        ctx.shadowBlur = 18;
      }
      // a browser tab in silhouette: flat bottom, rounded top corners
      const w = 16;
      const h = 11;
      ctx.fillStyle = "#e8eefb";
      ctx.beginPath();
      ctx.roundRect(-w / 2, -h / 2, w, h, [4, 4, 1.5, 1.5]);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = `rgba(${ION.r}, ${ION.g}, ${ION.b}, 0.9)`;
      ctx.beginPath();
      ctx.arc(-w / 2 + 4, -0.5, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    const drawComet = (c: Comet, dt: number) => {
      c.life += dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.trail.unshift({ x: c.x, y: c.y, age: 0 });
      for (const p of c.trail) p.age += dt;
      const keep = c.bright ? 1.1 : 0.8;
      while (c.trail.length && c.trail[c.trail.length - 1].age > keep) c.trail.pop();

      const fade = Math.min(1, (c.maxLife - c.life) / 0.6, c.life / 0.15 + 0.2);
      // burn trail: emerald dying into the dark, warm nucleus flash when launched
      for (let i = 1; i < c.trail.length; i++) {
        const a = c.trail[i - 1];
        const b = c.trail[i];
        const t = 1 - a.age / keep;
        const alpha = t * t * 0.55 * fade;
        if (alpha <= 0.01) continue;
        const warm = c.bright && a.age < 0.18;
        const col = warm ? TEL : ION;
        ctx.strokeStyle = `rgba(${col.r}, ${col.g}, ${col.b}, ${alpha})`;
        ctx.lineWidth = (c.bright ? 3.2 : 2.2) * t + 0.4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      const angle = Math.atan2(c.vy, c.vx);
      drawTab(c.x, c.y, angle, c.size * fade, c.bright);
      return c.life < c.maxLife && c.x < width + 60 && c.y < height + 60 && c.y > -80;
    };

    const drawWake = (dt: number) => {
      for (const p of wake) p.age += dt;
      while (wake.length && wake[0].age > 0.6) wake.shift();
      for (const p of wake) {
        const t = 1 - p.age / 0.6;
        ctx.fillStyle = `rgba(${ION.r}, ${ION.g}, ${ION.b}, ${t * 0.35})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.4 * t + 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      ctx.clearRect(0, 0, width, height);
      drawStars(now);
      drawWake(dt);
      for (let i = queued.length - 1; i >= 0; i--) {
        queued[i].in -= dt;
        if (queued[i].in <= 0) {
          spawnComet(queued[i].origin);
          queued.splice(i, 1);
        }
      }
      spawnIn -= dt * 1000;
      if (spawnIn <= 0) {
        spawnComet();
        spawnIn = 2600 + Math.random() * 3800;
      }
      for (let i = comets.length - 1; i >= 0; i--) {
        if (!drawComet(comets[i], dt)) comets.splice(i, 1);
      }
      raf = requestAnimationFrame(frame);
    };

    const onLaunch = (e: Event) => {
      const origin = (e as CustomEvent<{ x: number; y: number }>).detail;
      spawnComet(origin, true);
      if (!origin) return; // no origin, no flock — one ambient comet is the whole event
      for (let i = 1; i < BURST; i++) {
        queued.push({ origin, in: i * 0.085 + Math.random() * 0.05 });
      }
    };
    const onPointer = (e: PointerEvent) => {
      wake.push({ x: e.clientX, y: e.clientY, age: 0 });
      if (wake.length > 40) wake.shift();
    };
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
      } else if (!reduced) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener(LAUNCH_EVENT, onLaunch);
    document.addEventListener("visibilitychange", onVisibility);
    if (!reduced) {
      window.addEventListener("pointermove", onPointer);
      raf = requestAnimationFrame(frame);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener(LAUNCH_EVENT, onLaunch);
      window.removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10"
    />
  );
}
