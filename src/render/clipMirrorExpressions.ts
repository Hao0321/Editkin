interface Expressions { x: string; y: string; scale: string; rotation: string; opacity: string; flipX?: boolean; flipY?: boolean; }
const product = (left: string, right: string) => left === "1" ? right : right === "1" ? left : `(${left})*(${right})`;
const sum = (left: string, right: string) => left === "0" ? right : right === "0" ? left : `(${left})+(${right})`;
/** R(parent) D(parent) R(child) D(child); reflection reverses the child rotation. */
export function reflectedTransformExpressions(parent: Expressions, child: Expressions): Expressions {
  const radians = `((${parent.rotation})*PI/180)`, sx = parent.flipX ? -1 : 1, sy = parent.flipY ? -1 : 1;
  const x = sx < 0 ? `-(${child.x})` : child.x, y = sy < 0 ? `-(${child.y})` : child.y;
  return {
    x: `(${parent.x})+((${x})*(${parent.scale})*cos(${radians}))-((${y})*(${parent.scale})*sin(${radians}))`,
    y: `(${parent.y})+((${x})*(${parent.scale})*sin(${radians}))+((${y})*(${parent.scale})*cos(${radians}))`,
    scale: product(parent.scale, child.scale), rotation: sum(parent.rotation, sx * sy < 0 ? `-(${child.rotation})` : child.rotation), opacity: product(parent.opacity, child.opacity),
    flipX: Boolean(parent.flipX) !== Boolean(child.flipX), flipY: Boolean(parent.flipY) !== Boolean(child.flipY),
  };
}
