import { describe, expect, it } from 'vitest';
import { buildReserveChartData, buildReserveProgressData } from '../src/lib/reserveChart';
import type { ProjectionMonth } from '../src/lib/types';

function month(month: string, openingCents: number, targets: [number | null, number | null, number | null, number | null]): ProjectionMonth {
  return {
    month, openingCents, incomeCents: 20_000, expenseCents: 10_000,
    contributionCents: 0, availableCents: 10_000, returnCents: 0,
    netCents: 10_000, closingCents: openingCents + 10_000,
    indicators: {
      pms: { targetCents: targets[0], progressPercent: null },
      pmr: { targetCents: targets[1], progressPercent: null },
      pi: { targetCents: targets[2], progressPercent: null },
      pnif: { targetCents: targets[3], progressPercent: null },
    },
  };
}

describe('reserve chart data', () => {
  it('uses each indicator target directly in cents rather than recalculating from spending', () => {
    const row = month('2032-10', 12_345, [61_001, 122_003, 345_007, 1_234_567]);
    expect(buildReserveChartData([row])).toEqual([{
      month: '2032-10', openingCents: 12_345,
      pms: 61_001, pmr: 122_003, pi: 345_007, pnif: 1_234_567,
    }]);
  });

  it('keeps changing monthly targets and the opening balance rather than the closing balance', () => {
    expect(buildReserveChartData([
      month('2032-10', 5_000, [60_000, 120_000, 300_000, 1_200_000]),
      month('2032-11', 15_000, [30_000, 60_000, 150_000, 600_000]),
    ])).toEqual([
      { month: '2032-10', openingCents: 5_000, pms: 60_000, pmr: 120_000, pi: 300_000, pnif: 1_200_000 },
      { month: '2032-11', openingCents: 15_000, pms: 30_000, pmr: 60_000, pi: 150_000, pnif: 600_000 },
    ]);
  });

  it('leaves unavailable or zero targets as gaps while preserving zero and negative reserves', () => {
    expect(buildReserveChartData([
      month('2032-10', 0, [60_000, 120_000, null, null]),
      month('2032-11', -5_000, [0, 0, 0, null]),
      month('2032-12', 5_000, [30_000, 60_000, 150_000, 600_000]),
    ])).toEqual([
      { month: '2032-10', openingCents: 0, pms: 60_000, pmr: 120_000, pi: null, pnif: null },
      { month: '2032-11', openingCents: -5_000, pms: null, pmr: null, pi: null, pnif: null },
      { month: '2032-12', openingCents: 5_000, pms: 30_000, pmr: 60_000, pi: 150_000, pnif: 600_000 },
    ]);
  });

  it('preserves input order and data without attaching chart fields to projection rows', () => {
    const rows = [
      month('2032-11', 20_000, [40_000, 80_000, 200_000, 800_000]),
      month('2032-10', 10_000, [60_000, 120_000, null, null]),
    ];
    const before = structuredClone(rows);
    const chart = buildReserveChartData(rows);
    expect(chart.map(row => row.month)).toEqual(['2032-11', '2032-10']);
    chart[0].openingCents = 99_999;
    expect(rows).toEqual(before);
  });

  it('handles an empty plan without inventing reserve or target data', () => {
    expect(buildReserveChartData([])).toEqual([]);
  });

});

describe('reserve progress chart data', () => {
  it('compares each monthly target using its opening reserve, regardless of stored indicator progress', () => {
    const row = month('2032-10', 30_000, [60_000, 120_000, 300_000, 1_200_000]);
    row.indicators.pms.progressPercent = 99;
    expect(buildReserveProgressData([row])).toEqual([
      { month: '2032-10', pms: 50, pmr: 25, pi: 10, pnif: 2.5 },
    ]);
  });

  it('recalculates progress when spending changes the target without implying reserve growth', () => {
    expect(buildReserveProgressData([
      month('2032-10', 30_000, [60_000, 120_000, 300_000, 1_200_000]),
      month('2032-11', 30_000, [30_000, 60_000, 150_000, 600_000]),
    ])).toEqual([
      { month: '2032-10', pms: 50, pmr: 25, pi: 10, pnif: 2.5 },
      { month: '2032-11', pms: 100, pmr: 50, pi: 20, pnif: 5 },
    ]);
  });

  it('preserves negative, zero, and over-100 percent progress without capping the chart', () => {
    expect(buildReserveProgressData([
      month('2032-10', -30_000, [60_000, 120_000, 300_000, 1_200_000]),
      month('2032-11', 0, [60_000, 120_000, 300_000, 1_200_000]),
      month('2032-12', 180_000, [60_000, 120_000, 300_000, 1_200_000]),
    ])).toEqual([
      { month: '2032-10', pms: -50, pmr: -25, pi: -10, pnif: -2.5 },
      { month: '2032-11', pms: 0, pmr: 0, pi: 0, pnif: 0 },
      { month: '2032-12', pms: 300, pmr: 150, pi: 60, pnif: 15 },
    ]);
  });

  it('uses gaps for unavailable, zero, or invalid targets instead of infinite or misleading percentages', () => {
    expect(buildReserveProgressData([
      month('2032-10', 10_000, [null, 0, -1, Infinity]),
      month('2032-11', 10_000, [NaN, 0.5, Number.MAX_SAFE_INTEGER + 1, 20_000]),
      month('2032-12', Infinity, [60_000, 120_000, 300_000, 1_200_000]),
    ])).toEqual([
      { month: '2032-10', pms: null, pmr: null, pi: null, pnif: null },
      { month: '2032-11', pms: null, pmr: null, pi: null, pnif: 50 },
      { month: '2032-12', pms: null, pmr: null, pi: null, pnif: null },
    ]);
  });

  it('does not mutate projection rows, reorder months, or extend the forecast horizon', () => {
    const rows = [
      month('2032-11', 10_000, [20_000, 40_000, null, null]),
      month('2032-10', 5_000, [20_000, 40_000, null, null]),
    ];
    const before = structuredClone(rows);
    const progress = buildReserveProgressData(rows);
    expect(progress.map(row => row.month)).toEqual(['2032-11', '2032-10']);
    progress[0].pms = 0;
    expect(rows).toEqual(before);
    expect(buildReserveProgressData([])).toEqual([]);
  });
});
