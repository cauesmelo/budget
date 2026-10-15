import type { ProjectionMonth } from './types';

export type ReserveTargetKey = keyof ProjectionMonth['indicators'];

export const reserveTargetDefinitions: readonly { key: ReserveTargetKey; label: string; name: string }[] = [
  { key: 'pms', label: 'PMS', name: 'Minimum survival reserve' },
  { key: 'pmr', label: 'PMR', name: 'Recommended minimum reserve' },
  { key: 'pi', label: 'PI', name: 'Ideal assets' },
  { key: 'pnif', label: 'PNIF', name: 'Financial independence assets' },
];

export type ReserveChartPoint = Pick<ProjectionMonth, 'month' | 'openingCents'> & Record<ReserveTargetKey, number | null>;

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
