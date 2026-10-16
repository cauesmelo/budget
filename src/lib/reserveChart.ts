import type { ProjectionMonth } from './types';

export type ReserveTargetKey = keyof ProjectionMonth['indicators'];

export const reserveTargetDefinitions: readonly { key: ReserveTargetKey; label: string; name: string }[] = [
  { key: 'pms', label: 'PMS', name: 'Minimum survival reserve' },
  { key: 'pmr', label: 'PMR', name: 'Recommended minimum reserve' },
  { key: 'pi', label: 'PI', name: 'Ideal assets' },
  { key: 'pnif', label: 'PNIF', name: 'Financial independence assets' },
];

export type ReserveChartPoint = Pick<ProjectionMonth, 'month' | 'openingCents'> & Record<ReserveTargetKey, number | null>;
export type ReserveProgressPoint = Pick<ProjectionMonth, 'month'> & Record<ReserveTargetKey, number | null>;

/** Keep every series in cents and use the same monthly targets as the indicator cards. */
export function buildReserveChartData(rows: readonly ProjectionMonth[]): ReserveChartPoint[] {
  return rows.map(row => {
    const target = (key: ReserveTargetKey): number | null => {
      const value = row.indicators[key].targetCents;
      return value !== null && value > 0 ? value : null;
    };
    return {
      month: row.month,
      openingCents: row.openingCents,
      pms: target('pms'),
      pmr: target('pmr'),
      pi: target('pi'),
      pnif: target('pnif'),
    };
  });
}

/** Compare goals on a shared percentage scale without hiding debt or progress beyond a target. */
export function buildReserveProgressData(rows: readonly ProjectionMonth[]): ReserveProgressPoint[] {
  return rows.map(row => {
    const progress = (key: ReserveTargetKey): number | null => {
      const targetCents = row.indicators[key].targetCents;
      return targetCents !== null && Number.isSafeInteger(targetCents) && targetCents > 0 && Number.isSafeInteger(row.openingCents)
        ? row.openingCents / targetCents * 100
        : null;
    };
    return {
      month: row.month,
      pms: progress('pms'),
      pmr: progress('pmr'),
      pi: progress('pi'),
      pnif: progress('pnif'),
    };
  });
}
