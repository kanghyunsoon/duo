/** Minimal 2D physics for the match simulation. */
export interface Vector {
  x: number;
  y: number;
}

export interface Body {
  id: string;
  position: Vector;
  velocity: Vector;
  radius: number;
  mass: number;
}

export const GRAVITY: Vector = { x: 0, y: -9.81 };

export function add(a: Vector, b: Vector): Vector {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function scale(v: Vector, k: number): Vector {
  return { x: v.x * k, y: v.y * k };
}

export function length(v: Vector): number {
  return Math.hypot(v.x, v.y);
}

export function normalize(v: Vector): Vector {
  const n = length(v);
  return n === 0 ? { x: 0, y: 0 } : scale(v, 1 / n);
}

/** Advances a body by dt seconds with semi-implicit Euler integration. */
export function step(body: Body, dt: number): Body {
  const velocity = add(body.velocity, scale(GRAVITY, dt));
  return { ...body, velocity, position: add(body.position, scale(velocity, dt)) };
}

export function collides(a: Body, b: Body): boolean {
  const dx = a.position.x - b.position.x;
  const dy = a.position.y - b.position.y;
  return Math.hypot(dx, dy) < a.radius + b.radius;
}

/** Elastic collision response between two bodies. */
export function resolveCollision(a: Body, b: Body): [Body, Body] {
  const normal = normalize({ x: b.position.x - a.position.x, y: b.position.y - a.position.y });
  const relative = { x: a.velocity.x - b.velocity.x, y: a.velocity.y - b.velocity.y };
  const speed = relative.x * normal.x + relative.y * normal.y;
  if (speed <= 0) return [a, b];
  const impulse = (2 * speed) / (a.mass + b.mass);
  return [
    { ...a, velocity: add(a.velocity, scale(normal, -impulse * b.mass)) },
    { ...b, velocity: add(b.velocity, scale(normal, impulse * a.mass)) },
  ];
}

/** Runs the world forward and resolves every pairwise collision once per step. */
export function simulate(bodies: readonly Body[], dt: number, steps: number): Body[] {
  let world = [...bodies];
  for (let s = 0; s < steps; s++) {
    world = world.map((b) => step(b, dt));
    for (let i = 0; i < world.length; i++) {
      for (let j = i + 1; j < world.length; j++) {
        const a = world[i];
        const b = world[j];
        if (a === undefined || b === undefined || !collides(a, b)) continue;
        const [na, nb] = resolveCollision(a, b);
        world[i] = na;
        world[j] = nb;
      }
    }
  }
  return world;
}

/** Keeps bodies inside the arena by reflecting them off the walls. */
export function clampToArena(body: Body, width: number, height: number): Body {
  let { x, y } = body.position;
  let { x: vx, y: vy } = body.velocity;
  if (x < body.radius) { x = body.radius; vx = Math.abs(vx); }
  if (x > width - body.radius) { x = width - body.radius; vx = -Math.abs(vx); }
  if (y < body.radius) { y = body.radius; vy = Math.abs(vy); }
  if (y > height - body.radius) { y = height - body.radius; vy = -Math.abs(vy); }
  return { ...body, position: { x, y }, velocity: { x: vx, y: vy } };
}
