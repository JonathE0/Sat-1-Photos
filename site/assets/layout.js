// Justified rows for the mosaic: every picture keeps its own shape (4:3 PiCAM,
// 1:1 ADCS), all pictures in a row share one height, and each row fills the
// width exactly. Now and then a row gets a larger target height, which gives
// fewer, bigger pictures and a bit of rhythm down the page.

// ratios: width / height for each picture, in order.
// featureEvery: a featured row is due after this many rows (0 turns it off);
// canFeature(start) says whether a row starting at that picture may be one.
// Returns [{ start, count, height, ragged, featured }]. A ragged row is the
// last one when it is too short to stretch; it keeps the target height.
export function justifyRows(ratios, options) {
  const {
    width,
    gap = 6,
    targetHeight,
    featureEvery = 0,
    canFeature = () => true,
    featureScale = 1.8,
    minPerRow = 1,
    maxPerRow = Infinity,
    lastRowStretch = 1.3,
  } = options;

  const rows = [];
  let start = 0;
  let sinceFeatured = Infinity;
  while (start < ratios.length) {
    const due = featureEvery > 0 && sinceFeatured >= featureEvery - 1;
    const isFeatured = due && start + 1 < ratios.length && canFeature(start);
    sinceFeatured = isFeatured ? 0 : sinceFeatured + 1;
    const target = targetHeight * (isFeatured ? featureScale : 1);
    const heightFor = (count, sum) => (width - gap * (count - 1)) / sum;

    let sum = 0;
    let count = 0;
    let chosen = null;
    while (start + count < ratios.length && count < maxPerRow) {
      sum += ratios[start + count];
      count += 1;
      const height = heightFor(count, sum);
      if (height <= target && count >= minPerRow) {
        // This picture took the row below the target height. Keep it, or end
        // the row before it, whichever lands closer to the target.
        if (count - 1 >= Math.max(1, minPerRow)) {
          const before = heightFor(count - 1, sum - ratios[start + count - 1]);
          if (Math.abs(Math.log(before / target)) < Math.abs(Math.log(height / target))) {
            chosen = { count: count - 1, height: before };
            break;
          }
        }
        chosen = { count, height };
        break;
      }
    }

    if (!chosen) {
      const height = heightFor(count, sum);
      const isLast = start + count >= ratios.length;
      chosen = isLast && count < maxPerRow && height > target * lastRowStretch
        ? { count, height: target, ragged: true }
        : { count, height };
    }

    rows.push({
      start,
      count: chosen.count,
      height: chosen.height,
      ragged: Boolean(chosen.ragged),
      featured: isFeatured,
    });
    start += chosen.count;
  }
  return rows;
}

// Settings for a given mosaic width. Phones get two pictures per row and no
// featured rows.
export function mosaicSettings(width) {
  if (width < 560) {
    const gap = 4;
    return {
      width,
      gap,
      // A lone last picture comes out as wide as one of two 4:3 columns.
      targetHeight: (width - gap) / 2 / (4 / 3),
      minPerRow: 2,
      maxPerRow: 2,
      lastRowStretch: 1.05,
    };
  }
  const gap = 6;
  return {
    width,
    gap,
    targetHeight: Math.min(300, Math.max(170, width / 5.2)),
    featureEvery: 4,
    featureScale: 1.6, // featured rows near the pictures' own 480 px height, not past it
    maxPerRow: 9,
  };
}

// Width / height used for layout, kept within sane bounds so an odd strip
// (for example a frame cut short on board) can't take over a row.
export function layoutRatio(width, height) {
  const r = width / height;
  if (!Number.isFinite(r) || r <= 0) return 4 / 3;
  return Math.min(2.4, Math.max(0.6, r));
}
