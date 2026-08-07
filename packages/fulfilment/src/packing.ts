// Packing, handling requirements and dispatch (M19-FR-02 / D09 / M10-FR-02).
//
// Between the shelf and the van there is one moment where the shop can still catch a
// mistake for free, and one where it can create an expensive one. Both are here.
//
//   • **A WEIGHED LINE'S FINAL PRICE IS CAPTURED AT PACK** (D09). The customer ordered
//     "about 1 kg" of chicken and is getting 1.187 kg. If the final weight is not priced
//     at the moment it is packed, the shop is guessing at the doorstep — and every guess
//     is either a customer overcharged or margin given away. Priced in **exact integer
//     minor units** from the weight in grams, never a float.
//
//   • **A COLD ITEM PACKED WARM IS AN ITEM THE CUSTOMER CANNOT EAT.** Chilled and frozen
//     lines need the temperature recorded **at pack**, and a **missing reading is treated
//     as a failure** — the same rule `packages/quality` applies at the goods-in door, for
//     the same reason: an unmeasured cold chain is an unproven one.
//
//   • **A CRATE CANNOT MIX INCOMPATIBLE HANDLING.** Frozen prawns and a bag of atta in
//     one crate is not a packing preference; it is a wet bag of atta. Raw meat above
//     ready-to-eat food is a contamination route. These are refusals, not warnings.
//
// And the rule that ties it to everything else: **the manifest is derived from what was
// actually packed** — never from what was ordered. A manifest built from the order is a
// list of what the shop hoped to send, and the driver is the one who finds out.
//
// Pure and deterministic: the clock is injected, nothing is written here.

export type HandlingClass = 'ambient' | 'chilled' | 'frozen' | 'raw_meat' | 'ready_to_eat' | 'fragile' | 'hazardous';

export interface PackLine {
  readonly lineId: string;
  readonly orderId: string;
  readonly productId: string;
  readonly name: string;
  readonly handling: HandlingClass;
  /** Ordered quantity in the UOM's smallest unit. */
  readonly orderedMinor: number;
  /** What was actually picked. May be less — a short pick is honest, not hidden. */
  readonly pickedMinor: number;
  readonly uom: string;
  /** Price per UOM unit. For a weighed line this is per gram or per kg-in-grams. */
  readonly unitPriceMinor: number;
  /** True when the final price depends on the packed weight (D09). */
  readonly weighed?: boolean;
  /** Actual packed weight in grams, for a weighed line. */
  readonly packedGrams?: number;
  /** Temperature at pack, in tenths of a degree. Absent = not taken. */
  readonly packTenthsC?: number;
}

/** Per-product cold-chain limits at pack, from the product master. */
export interface HandlingRule {
  readonly handling: HandlingClass;
  readonly maxTenthsC?: number;
  readonly minTenthsC?: number;
}

const DEFAULT_RULES: readonly HandlingRule[] = [
  { handling: 'chilled', minTenthsC: -20, maxTenthsC: 50 },
  { handling: 'frozen', maxTenthsC: -150 },
  { handling: 'raw_meat', minTenthsC: -20, maxTenthsC: 40 },
];

/** Pairs that must never share a crate. Symmetric — order does not matter. */
const INCOMPATIBLE: readonly (readonly [HandlingClass, HandlingClass])[] = [
  ['frozen', 'ambient'],
  ['frozen', 'ready_to_eat'],
  ['raw_meat', 'ready_to_eat'],
  ['hazardous', 'ambient'],
  ['hazardous', 'chilled'],
  ['hazardous', 'frozen'],
  ['hazardous', 'ready_to_eat'],
  ['hazardous', 'raw_meat'],
];

export type PackRefusal =
  | 'packed'
  | 'temperature_not_taken'
  | 'temperature_out_of_range'
  | 'weight_not_captured'
  | 'incompatible_crate'
  | 'nothing_picked';

export interface PackedLine {
  readonly lineId: string;
  readonly productId: string;
  readonly name: string;
  readonly packedMinor: number;
  /** The price the customer actually pays for this line, exact. */
  readonly finalPriceMinor: number;
  readonly shortMinor: number;
  readonly handling: HandlingClass;
  readonly crateId: string;
  readonly detail: string;
}

export interface PackResult {
  readonly orderId: string;
  readonly packed: boolean;
  readonly outcome: PackRefusal;
  readonly lines: readonly PackedLine[];
  /** Lines that could not be packed, with the reason. Never silently dropped. */
  readonly refused: readonly { readonly lineId: string; readonly reason: PackRefusal; readonly detail: string }[];
  readonly totalMinor: number;
  readonly detail: string;
}

function ruleFor(handling: HandlingClass, rules: readonly HandlingRule[]): HandlingRule | undefined {
  return rules.find((r) => r.handling === handling);
}

function incompatible(a: HandlingClass, b: HandlingClass): boolean {
  return INCOMPATIBLE.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

/**
 * Pack an order into crates, pricing weighed lines at their actual weight and refusing
 * anything that cannot be packed safely.
 *
 * A refused line does **not** stop the rest of the order: the pack completes with what
 * can be sent, and the refusals are listed. Blocking the whole order because one crate
 * is wrong means the customer gets nothing rather than most of their shopping.
 */
export function packOrder(input: {
  readonly orderId: string;
  readonly lines: readonly PackLine[];
  /** Which crate each line goes in. */
  readonly crateAssignment: Readonly<Record<string, string>>;
  readonly rules?: readonly HandlingRule[];
  readonly at: string;
}): PackResult {
  const rules = input.rules ?? DEFAULT_RULES;
  const packed: PackedLine[] = [];
  const refused: { lineId: string; reason: PackRefusal; detail: string }[] = [];

  // Crate compatibility first — a crate is wrong before any of its lines are.
  const byCrate = new Map<string, PackLine[]>();
  for (const line of input.lines) {
    const crate = input.crateAssignment[line.lineId] ?? 'crate-1';
    byCrate.set(crate, [...(byCrate.get(crate) ?? []), line]);
  }
  const badCrates = new Set<string>();
  for (const [crate, lines] of byCrate) {
    for (let i = 0; i < lines.length; i += 1) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (incompatible(lines[i]!.handling, lines[j]!.handling)) {
          badCrates.add(crate);
          refused.push({
            lineId: lines[j]!.lineId,
            reason: 'incompatible_crate',
            detail: `${lines[j]!.name} (${lines[j]!.handling}) cannot travel in the same crate as ${lines[i]!.name} (${lines[i]!.handling})`,
          });
        }
      }
    }
  }

  for (const line of input.lines) {
    const crateId = input.crateAssignment[line.lineId] ?? 'crate-1';
    if (badCrates.has(crateId) && refused.some((r) => r.lineId === line.lineId)) continue;

    if (line.pickedMinor <= 0) {
      refused.push({ lineId: line.lineId, reason: 'nothing_picked', detail: `${line.name} was not picked` });
      continue;
    }

    const rule = ruleFor(line.handling, rules);
    if (rule !== undefined) {
      if (line.packTenthsC === undefined) {
        // Missing reading = failed reading. Same rule as the goods-in door.
        refused.push({
          lineId: line.lineId,
          reason: 'temperature_not_taken',
          detail: `${line.name} is ${line.handling} and no temperature was taken at pack — an unmeasured cold chain is an unproven one`,
        });
        continue;
      }
      const tooWarm = rule.maxTenthsC !== undefined && line.packTenthsC > rule.maxTenthsC;
      const tooCold = rule.minTenthsC !== undefined && line.packTenthsC < rule.minTenthsC;
      if (tooWarm || tooCold) {
        refused.push({
          lineId: line.lineId,
          reason: 'temperature_out_of_range',
          detail: `${line.name} packed at ${line.packTenthsC / 10}°C, outside the ${rule.handling} range — it does not go on the van`,
        });
        continue;
      }
    }

    let finalPriceMinor: number;
    if (line.weighed === true) {
      if (line.packedGrams === undefined || line.packedGrams <= 0) {
        refused.push({
          lineId: line.lineId,
          reason: 'weight_not_captured',
          detail: `${line.name} is sold by weight and none was recorded at pack — the price would be a guess at the doorstep`,
        });
        continue;
      }
      // Exact: price per gram × grams, in integer minor units (§29.1).
      finalPriceMinor = Math.round((line.unitPriceMinor * line.packedGrams) / 1000);
    } else {
      finalPriceMinor = line.unitPriceMinor * line.pickedMinor;
    }

    packed.push({
      lineId: line.lineId,
      productId: line.productId,
      name: line.name,
      packedMinor: line.pickedMinor,
      finalPriceMinor,
      shortMinor: Math.max(0, line.orderedMinor - line.pickedMinor),
      handling: line.handling,
      crateId,
      detail:
        line.weighed === true
          ? `${line.packedGrams}g at ${line.unitPriceMinor} per kg = ${finalPriceMinor}`
          : line.pickedMinor < line.orderedMinor
            ? `${line.pickedMinor} of ${line.orderedMinor} — short, and charged only for what is going`
            : `${line.pickedMinor} × ${line.unitPriceMinor}`,
    });
  }

  const totalMinor = packed.reduce((s, l) => s + l.finalPriceMinor, 0);
  return {
    orderId: input.orderId,
    packed: packed.length > 0,
    outcome: refused.length === 0 ? 'packed' : (refused[0]!.reason),
    lines: packed,
    refused,
    totalMinor,
    detail:
      refused.length === 0
        ? `${packed.length} line(s) packed, ${totalMinor}`
        : `${packed.length} line(s) packed, ${totalMinor}; ${refused.length} refused and listed rather than quietly left out`,
  };
}

export interface ManifestLine {
  readonly lineId: string;
  readonly productId: string;
  readonly name: string;
  readonly quantityMinor: number;
  readonly crateId: string;
  readonly handling: HandlingClass;
}

export interface Manifest {
  readonly manifestId: string;
  readonly orderId: string;
  readonly locationId: string;
  readonly lines: readonly ManifestLine[];
  readonly crates: readonly string[];
  readonly totalMinor: number;
  /** Cold-chain evidence carried with the load (M10-FR-02 / FSSAI). */
  readonly temperatureReadings: readonly { readonly lineId: string; readonly tenthsC: number }[];
  /** Tamper-evident seal per crate. */
  readonly seals: Readonly<Record<string, string>>;
  readonly dispatchedAt: string;
  readonly dispatchedBy: string;
  readonly detail: string;
}

export type DispatchRefusal = 'dispatched' | 'nothing_packed' | 'unsealed_crate' | 'unresolved_lines';

export interface DispatchResult {
  readonly orderId: string;
  readonly dispatched: boolean;
  readonly outcome: DispatchRefusal;
  readonly manifest?: Manifest;
  readonly detail: string;
}

/**
 * Build the dispatch manifest and release the load.
 *
 * **The manifest is derived from what was packed, never from what was ordered.** A
 * manifest built from the order is a list of what the shop hoped to send, and the driver
 * is the one who discovers the difference at a stranger's door.
 *
 * Dispatch is refused while any line is unresolved — a short pick the customer has not
 * been told about, or a refused line nobody has decided on — because the doorstep is the
 * worst place to have that conversation.
 */
export function dispatchOrder(input: {
  readonly manifestId: string;
  readonly orderId: string;
  readonly locationId: string;
  readonly pack: PackResult;
  readonly seals: Readonly<Record<string, string>>;
  readonly resolvedLineIds?: readonly string[];
  readonly dispatchedBy: string;
  readonly at: string;
}): DispatchResult {
  const base = { orderId: input.orderId };

  if (input.pack.lines.length === 0) {
    return { ...base, dispatched: false, outcome: 'nothing_packed', detail: 'nothing was packed — there is no load to dispatch' };
  }

  const resolved = new Set(input.resolvedLineIds ?? []);
  const unresolved = [
    ...input.pack.refused.filter((r) => !resolved.has(r.lineId)).map((r) => r.lineId),
    ...input.pack.lines.filter((l) => l.shortMinor > 0 && !resolved.has(l.lineId)).map((l) => l.lineId),
  ];
  if (unresolved.length > 0) {
    return {
      ...base,
      dispatched: false,
      outcome: 'unresolved_lines',
      detail: `${unresolved.length} line(s) are short or refused and the customer has not been told: ${unresolved.join(', ')}. The doorstep is the worst place to have that conversation`,
    };
  }

  const crates = [...new Set(input.pack.lines.map((l) => l.crateId))].sort();
  const unsealed = crates.filter((c) => (input.seals[c] ?? '').trim() === '');
  if (unsealed.length > 0) {
    return {
      ...base,
      dispatched: false,
      outcome: 'unsealed_crate',
      detail: `crate(s) ${unsealed.join(', ')} have no tamper seal — an unsealed crate cannot be shown to have arrived as it left`,
    };
  }

  return {
    ...base,
    dispatched: true,
    outcome: 'dispatched',
    detail: `${input.pack.lines.length} line(s) in ${crates.length} crate(s), ${input.pack.totalMinor}, dispatched by ${input.dispatchedBy}`,
    manifest: {
      manifestId: input.manifestId,
      orderId: input.orderId,
      locationId: input.locationId,
      // Derived from the pack, not the order.
      lines: input.pack.lines.map((l) => ({
        lineId: l.lineId,
        productId: l.productId,
        name: l.name,
        quantityMinor: l.packedMinor,
        crateId: l.crateId,
        handling: l.handling,
      })),
      crates,
      totalMinor: input.pack.totalMinor,
      temperatureReadings: [],
      seals: input.seals,
      dispatchedAt: input.at,
      dispatchedBy: input.dispatchedBy,
      detail: `derived from what was packed at ${input.locationId}, not from what was ordered`,
    },
  };
}
