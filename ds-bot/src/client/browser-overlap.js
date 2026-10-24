export function rectsOverlap(a, b) {
  return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
    && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}
