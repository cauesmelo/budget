import type { FinanceData, PlanItem } from './types';

/** Unranked items follow the saved order so newly added rows append naturally. */
export function getOrderedPlanItems(data: FinanceData): PlanItem[] {
  if (!data.planOrder) return [...data.planItems];
  const byId = new Map(data.planItems.map(item => [item.id, item]));
  const ranked = new Set(data.planOrder.ids);
  return [
    ...data.planOrder.ids.flatMap(id => {
      const item = byId.get(id);
      return item ? [item] : [];
    }),
    ...data.planItems.filter(item => !ranked.has(item.id)),
  ];
}

function completeOrderIds(data: FinanceData): string[] {
  let ids = [...(data.planOrder?.ids ?? [])];
  const ranked = new Set(ids);
  for (const item of data.planItems) if (!ranked.has(item.id)) ids.push(item.id);
  if (ids.length > 10_000) {
    // Partial backups may retain references to absent records; keep real rows within the storage limit.
    const currentIds = new Set(data.planItems.map(item => item.id));
    ids = ids.filter(itemId => currentIds.has(itemId));
  }
  return ids;
}

/** Save addition order before record merges can sort newly added rows by ID. */
export function appendPlanItem(data: FinanceData, item: PlanItem, stamp: string): FinanceData {
  if (data.planItems.some(existing => existing.id === item.id)) return data;
  const next = { ...data, planItems: [...data.planItems, item] };
  return { ...next, planOrder: { ids: completeOrderIds(next), updatedAt: stamp }, updatedAt: stamp };
}

/** Reorder presentation independently of financial records and their edit clocks. */
export function movePlanItem(data: FinanceData, id: string, direction: 'up' | 'down', visibleIds: string[], stamp: string): FinanceData {
  if (direction !== 'up' && direction !== 'down') return data;
  const visible = new Set(visibleIds);
  const current = data.planItems.find(item => item.id === id && !item.deletedAt);
  if (!current || !visible.has(id)) return data;
  const eligible = getOrderedPlanItems(data).filter(item => !item.deletedAt && item.kind === current.kind && visible.has(item.id));
  const index = eligible.findIndex(item => item.id === id);
  const neighbor = eligible[index + (direction === 'up' ? -1 : 1)];
  if (!neighbor) return data;
  const ids = completeOrderIds(data);
  const from = ids.indexOf(id);
  const to = ids.indexOf(neighbor.id);
  [ids[from], ids[to]] = [ids[to], ids[from]];
  return { ...data, planOrder: { ids, updatedAt: stamp }, updatedAt: stamp };
}
