// The measurement harness for §32 — and, more importantly, the honest boundary around it.
//
// §32 states its POS targets **"on certified pilot hardware"**. That hardware is EX-09 and does
// not exist yet, so no test in this folder can certify *"scan-to-line p95 ≤ 300 ms"*. Pretending
// otherwise would be worse than not measuring: a green tick against a number nobody has actually
// hit on a real till is exactly the evidence somebody quotes at the pilot when the lane is slow.
//
// So this folder measures the two things that **are** settleable now, and says plainly what is
// not:
//
//   • **SHAPE, NOT SPEED.** A scan path that is O(n) in catalogue size blows the budget on real
//     hardware however fast the machine is, and no amount of a faster till saves it. Measuring
//     whether doubling the catalogue doubles the work is **hardware-independent**, and it is the
//     regression that actually reaches production — somebody replaces a `Map.get` with an
//     `Array.find` in a refactor and every test still passes on a 240-product fixture.
//   • **WORK COUNT, NOT WALL CLOCK.** How many lookups, appends and allocations one scan costs
//     is deterministic: same input, same number, on every machine and in every CI run. A budget
//     expressed in operations cannot flake, and a wall-clock budget on a shared container
//     always eventually does — and a flaky performance test gets its threshold raised until it
//     is measuring nothing.
//
// Wall-clock **is** recorded, with a deliberately loose headroom multiple. Its job is to catch a
// fifty-fold regression, not to certify a target. `HEADROOM` says so in its name.
//
// Pure and dependency-free: `process.hrtime.bigint` and nothing else.

/** §32's quantitative targets, as the roadmap states them. Referenced, never asserted directly. */
export const TARGETS = {
  posScanToLineMs: 300,
  posTotalTenderMs: 500,
  catalogueSearchMs: 1_000,
  customerCheckoutMs: 2_000,
  syncBacklogDrainHours: 2,
  syncBacklogPeakHours: 24,
} as const;

/**
 * How much slower than this machine a certified till is allowed to be before the wall-clock
 * assertions here stop meaning anything.
 *
 * A cheap Android-class till or a low-end x86 lane box runs maybe 10–20× slower than a CI
 * container on a good day. Asserting at **50×** leaves that margin and still fails loudly on a
 * regression that matters — an accidental O(n²) over a basket does not cost 50%, it costs orders
 * of magnitude. Anything between 1× and 50× is a real measurement this harness deliberately
 * does not adjudicate: **that is EX-09's job, not CI's.**
 */
export const HEADROOM = 50;

export interface Sample {
  readonly label: string;
  readonly runs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
};

/**
 * Time `operation` `runs` times and report percentiles.
 *
 * Warms up first and discards the warm-up entirely. A cold JIT makes the first few iterations
 * ten times slower than the steady state, and including them measures the interpreter rather
 * than the code — which is how a p95 ends up dominated by a run that will never happen on a lane
 * that has been open since seven in the morning.
 */
export function measure(input: {
  readonly label: string;
  readonly runs: number;
  readonly warmup?: number;
  readonly operation: (iteration: number) => void;
}): Sample {
  const warmup = input.warmup ?? Math.max(10, Math.floor(input.runs / 10));
  for (let i = 0; i < warmup; i += 1) input.operation(i);

  const timings: number[] = new Array<number>(input.runs);
  for (let i = 0; i < input.runs; i += 1) {
    const started = process.hrtime.bigint();
    input.operation(i);
    timings[i] = Number(process.hrtime.bigint() - started) / 1e6;
  }

  const sorted = [...timings].sort((a, b) => a - b);
  return {
    label: input.label,
    runs: input.runs,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: percentile(sorted, 100),
    meanMs: timings.reduce((t, x) => t + x, 0) / timings.length,
  };
}

export interface ComplexityPoint {
  readonly n: number;
  readonly perOperationMs: number;
}

export interface ComplexityResult {
  readonly label: string;
  readonly points: readonly ComplexityPoint[];
  /** Cost at the largest n divided by cost at the smallest, for a size ratio of `sizeRatio`. */
  readonly growthFactor: number;
  readonly sizeRatio: number;
  readonly verdict: 'flat' | 'sublinear' | 'linear' | 'worse_than_linear';
  readonly detail: string;
}

/**
 * Measure how the cost of one operation changes as the data behind it grows.
 *
 * This is the assertion that survives being run on unknown hardware, because a **ratio** cancels
 * the machine out. If a scan costs the same at 100 products and at 100,000, it is O(1) whatever
 * the absolute figures were — and if it costs a thousand times more, no till will save it.
 *
 * `growthFactor` is deliberately compared against `sizeRatio` rather than against a constant:
 * the question is never *"is it fast"*, it is *"did the work grow with the data"*.
 */
export function measureComplexity(input: {
  readonly label: string;
  /** Ascending data sizes. At least two, ideally spanning two orders of magnitude. */
  readonly sizes: readonly number[];
  /** Build the fixture for size n. NOT timed — setup cost is not the operation's cost. */
  readonly setup: (n: number) => unknown;
  readonly operation: (fixture: unknown, iteration: number) => void;
  readonly runsPerSize?: number;
}): ComplexityResult {
  const runs = input.runsPerSize ?? 2_000;
  const points: ComplexityPoint[] = input.sizes.map((n) => {
    const fixture = input.setup(n);
    const sample = measure({
      label: `${input.label}@${n}`, runs,
      operation: (i) => input.operation(fixture, i),
    });
    // The MEDIAN, not the mean: one GC pause during a run should not be read as a complexity
    // class. Complexity is a property of the typical operation, not of the unluckiest one.
    return { n, perOperationMs: sample.p50Ms };
  });

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const sizeRatio = last.n / first.n;
  // A floor on the denominator: at sub-microsecond resolution the ratio is timer noise, not
  // growth, and dividing by a number that small manufactures a complexity class out of nothing.
  const floor = 1e-4;
  const growthFactor = Math.max(first.perOperationMs, floor) === floor && last.perOperationMs < floor
    ? 1
    : last.perOperationMs / Math.max(first.perOperationMs, floor);

  // The bands below are derived from measurement, not chosen for convenience. Comparing a `Map`
  // lookup against a deliberate `Array.find` regression over the same fixture, on this class of
  // machine, at 100× the data:
  //
  //     Map.get      0.000373 ms → 0.000705 ms     1.9× growth
  //     Array.find   0.088 ms    → 12.0 ms       136× growth
  //
  // So an O(1) operation still gets **measurably slower** as the data grows — at 50,000 entries
  // the map no longer fits in cache and every lookup is a miss. That is a constant factor from
  // the memory hierarchy, not a complexity class, and a band tight enough to reject it rejects
  // correct code. The real signal is the gap: 1.9 against 136. Anything from 5 to 50 separates
  // them cleanly, so `flat` sits at 4, well clear of the noise and two orders below a genuine
  // linear scan.
  //
  // `worse_than_linear` is set at 3× the size ratio for the same reason in the other direction:
  // allocation-heavy linear work (building maps, rehashing) legitimately carries a super-linear
  // constant, while quadratic over 10× data costs 100× and over 100× data costs 10,000×. The
  // band has to catch quadratic without flagging a rehash.
  const flatCeiling = Math.max(4, sizeRatio ** 0.3);
  const verdict: ComplexityResult['verdict'] =
    growthFactor <= flatCeiling ? 'flat'
      : growthFactor <= sizeRatio ** 0.7 ? 'sublinear'
        : growthFactor <= sizeRatio * 3 ? 'linear'
          : 'worse_than_linear';

  return {
    label: input.label,
    points,
    growthFactor,
    sizeRatio,
    verdict,
    detail: `${input.label}: data grew ${sizeRatio}×, cost per operation grew ${growthFactor.toFixed(2)}× — ${verdict}`,
  };
}

/**
 * A counting wrapper around a `Map`, so a test can assert **how many lookups** an operation
 * costs rather than how long it took.
 *
 * Fully deterministic: same input, same count, on every machine and in every run. This is the
 * assertion that never flakes and therefore never gets its threshold quietly raised.
 */
export class CountingMap<K, V> extends Map<K, V> {
  gets = 0;
  sets = 0;
  hits = 0;

  override get(key: K): V | undefined {
    this.gets += 1;
    const value = super.get(key);
    if (value !== undefined) this.hits += 1;
    return value;
  }

  override set(key: K, value: V): this {
    this.sets += 1;
    return super.set(key, value);
  }

  reset(): void {
    this.gets = 0;
    this.sets = 0;
    this.hits = 0;
  }
}

export interface BudgetReport {
  readonly label: string;
  readonly targetMs: number;
  readonly measuredP95Ms: number;
  /** How many times the §32 budget this machine actually used. Lower is better. */
  readonly usedFraction: number;
  readonly headroomMultiple: number;
  readonly withinHeadroom: boolean;
  /** Never `true`. Certification needs EX-09, and no CI run can grant it. */
  readonly certifiesTheTarget: false;
  readonly detail: string;
}

/**
 * Compare a measurement to a §32 budget — and refuse to call the result a certification.
 *
 * `certifiesTheTarget` is typed as the literal `false` for the same reason `shopKeepsTrading` is
 * typed `true` elsewhere: it is a claim somebody will otherwise make on this test's behalf in
 * eighteen months, when the folder is green and nobody remembers that the target says *certified
 * pilot hardware* and the hardware was never bought.
 */
export function againstBudget(input: {
  readonly label: string;
  readonly targetMs: number;
  readonly sample: Sample;
  readonly headroom?: number;
}): BudgetReport {
  const headroomMultiple = input.headroom ?? HEADROOM;
  const measuredP95Ms = input.sample.p95Ms;
  const usedFraction = measuredP95Ms / input.targetMs;
  const withinHeadroom = measuredP95Ms * headroomMultiple <= input.targetMs;

  return {
    label: input.label,
    targetMs: input.targetMs,
    measuredP95Ms,
    usedFraction,
    headroomMultiple,
    withinHeadroom,
    certifiesTheTarget: false,
    detail: withinHeadroom
      ? `${input.label}: p95 ${measuredP95Ms.toFixed(4)}ms against a §32 budget of ${input.targetMs}ms — ${(1 / Math.max(usedFraction, 1e-9)).toFixed(0)}× headroom on this machine, which leaves room for a till ${headroomMultiple}× slower. NOT a certification: §32 says certified pilot hardware (EX-09)`
      : `${input.label}: p95 ${measuredP95Ms.toFixed(4)}ms against ${input.targetMs}ms leaves under ${headroomMultiple}× headroom — a certified till is slower than CI, and this will not hold on one`,
  };
}

/**
 * What §32 asks that only real hardware and real volumes can answer.
 *
 * Recorded explicitly, in the same spirit as the AI package's `liveProviderGate()`: the boundary
 * between what is settled and what is pending has to be written down, or it gets blurred by
 * whoever needs it blurred.
 */
export function certifiedHardwareGate(): readonly { readonly what: string; readonly why: string }[] {
  return [
    {
      what: 'POS scan-to-line p95 ≤ 300 ms on the certified till',
      why: 'the budget is stated for certified pilot hardware; CI measures a container, and the ratio between the two is exactly what is unknown until a till exists (EX-09)',
    },
    {
      what: 'POS total/tender p95 ≤ 500 ms with a real card terminal attached',
      why: 'the target excludes external authorisation, but the serial or USB round trip to the terminal is ours and cannot be simulated honestly',
    },
    {
      what: 'Catalogue search p95 ≤ 1 s at audited scale',
      why: '"audited scale" is the real SKU count, which is a Stage-1 store fact (AVR-04) not yet measured',
    },
    {
      what: 'Sync backlog: clear a 24h peak within 2h over the store\'s real uplink',
      why: 'drain rate is bounded by the actual broadband at the store, not by how fast events can be produced in memory',
    },
    {
      what: 'Store-edge RTO ≤ 30 min on the real edge box',
      why: 'restore time is dominated by disk and the size of the real dataset',
    },
    {
      what: '72-hour offline endurance with a full day\'s trading queued',
      why: 'bounded by the till\'s real disk and the real basket rate; the queue arithmetic is proven here, the endurance is not',
    },
  ];
}
