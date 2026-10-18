const overrides = jest.fn().mockResolvedValue([
  { telegram_id: '2', display_name: 'Сохранённое имя' },
  { telegram_id: 'removed', display_name: 'Удалённый' },
]);
jest.mock('../src/db', () => ({ getStaffDisplayNameOverrides: overrides }));
jest.mock('../src/cache', () => ({ __esModule: true, default: { config: { staff_roles: [
  { telegram_id: '1', role: 'admin', name: '' }, { telegram_id: '2', role: 'agent', name: 'Из конфига' },
] }, staffMembers: new Map(), staffNameOverrides: new Map(), mutedTickets: new Set() } }));

import cache from '../src/cache';
import { initStaffCache } from '../src/team';
import { staffDisplayName } from '../src/staff-names';

it('loads persisted names before UI while config remains membership authority', async () => {
  await initStaffCache();
  expect(overrides).toHaveBeenCalledWith(['1', '2']);
  expect(staffDisplayName('2')).toBe('Сохранённое имя');
  expect(cache.staffMembers.has('removed')).toBe(false);
  expect(staffDisplayName('1')).toBe('Администратор');
});
