/* -------------------------------------------------------------------------
   The drawings

   Every small picture the page paints onto a canvas, in one place: the bubbles
   over people's heads and the marks on the full map. The same errand is the
   same picture wherever it turns up, so a berry patch on the map and somebody
   standing in one picking are recognisably one thing.

   Sixteen units a side, stroked unless they say otherwise — the same box and
   the same pen as the order row's icons in the page, which most of these are
   copied from. No imports: this is data, and both of its readers are in the
   middle of import cycles that it should not be part of.
   ------------------------------------------------------------------------- */
const ring = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

export const ICON_PATHS = {
  gather: { stroke: [ring(5.2, 6, 2.3), ring(10.8, 5.2, 2), ring(8, 10.8, 2.6)] },
  hunt: { stroke: ['M2.5 13.5 12 4', 'M9.2 3.4 13.2 2.6 12.5 6.6z'] },
  craft: { stroke: ['M8 2.2 13.4 12.4H2.6z', 'M5.4 8.6h5.2'] },
  tend: { stroke: ['M8 14c2.6 0 4.2-1.7 4.2-3.9C12.2 7 9.4 5.6 9.4 2 7 3.6 6.1 5.6 6.1 7.4c0 1-.6 1.4-1 1-.6-.5-.6-1.4-.6-1.4-.5 1-.7 2-.7 3.1C3.8 12.3 5.4 14 8 14z'] },
  sleep: { stroke: ['M13.4 9.4A5.6 5.6 0 0 1 6.2 2.4a5.8 5.8 0 1 0 7.2 7z'] },
  /* A visit is a trade: something goes each way. Two arrows passing, rather
     than the order row's two camps and a road, because what happens at the far
     end is the exchange and not the walk. */
  trade: { stroke: ['M3 5.5h9', 'M9.5 3 12 5.5 9.5 8', 'M13 10.5H4', 'M6.5 8 4 10.5 6.5 13'] },
  quarry: { stroke: ['M2.5 12.5 6 5l4.5 3L14 12.5Z', 'M6 5l1.6 3.5'] },
  fish: { stroke: ['M2.5 8c3-3.4 7.2-3.4 9.6 0-2.4 3.4-6.6 3.4-9.6 0Z', 'M12.1 8l2.4-2.2v4.4Z'] },
  raid: { stroke: ['M3 13 11 5', 'M9 3h4v4', 'M3 9l4 4'] },
  mourn: { stroke: ['M5.2 13V6.4a2.8 2.8 0 0 1 5.6 0V13', 'M3.6 13h8.8'] },
  // Into the basket: somebody putting food away.
  store: { stroke: ['M8 2v6', 'M5.5 5.5 8 8l2.5-2.5', 'M3 9.5h10l-1.3 4H4.3z'] },
  rest: { fill: [ring(4, 8.5, 1.15), ring(8, 8.5, 1.15), ring(12, 8.5, 1.15)] },
  nurse: { stroke: ['M8 13.2S2.6 9.6 2.6 6.1A2.8 2.8 0 0 1 8 4.6a2.8 2.8 0 0 1 5.4 1.5C13.4 9.6 8 13.2 8 13.2z'] },
  // A fruit with its stalk and a leaf: what hangs on the trees.
  fruit: { stroke: [ring(8, 9.6, 4.1), 'M8 5.5V2.8', 'M8 4.2c1.1-1.5 2.9-1.8 4.1-1.2-.9 1.5-2.6 2-4.1 1.2z'] },
  // The granary itself, on its stilts: where the food is kept.
  granary: { stroke: ['M2.6 7.4 8 3.2l5.4 4.2', 'M4.3 7.4v4.1h7.4V7.4', 'M5.2 11.5v2.3', 'M10.8 11.5v2.3'] },
  // Furrows and a sprout: a band's field.
  farm: { stroke: ['M2.4 13.4h11.2', 'M2.4 10.6h11.2', 'M8 10.6V5.4', 'M8 7.2C6.4 7.2 5 6.2 4.6 4.6 6.2 4.6 7.6 5.6 8 7.2z',
    'M8 6.2c1.6 0 3-1 3.4-2.6-1.6 0-3 1-3.4 2.6z'] },
  // A compass: somebody gone to see what is over the hill.
  explore: { stroke: [ring(8, 8, 5.6), 'M8 4.2l1.7 3.8L8 11.8 6.3 8z'] },
  // An axe in a log: cutting wood.
  wood: { stroke: ['M3 12.6 9.4 6.2', 'M8.3 3.7l3.5 3.5-2 2-3.5-3.5z', 'M8.6 13.4h5.2'] },
  // Logs lashed across two bars, and a paddle: a band's raft.
  raft: { stroke: ['M2.4 9.6h11.2', 'M2.4 12.2h11.2', 'M4 8.4v5', 'M12 8.4v5', 'M8.6 2.6l2.2 5.6'] },
};
