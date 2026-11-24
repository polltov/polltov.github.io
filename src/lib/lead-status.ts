export const LEAD_STATUSES = [
  { id: 'new', label: 'Новая', filter: 'Новые' },
  { id: 'in_progress', label: 'В работе', filter: 'В работе' },
  { id: 'rejected', label: 'Отклонена', filter: 'Отклонённые' },
  { id: 'closed', label: 'Закрыта', filter: 'Закрытые' },
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number]['id'];
export const DEFAULT_LEAD_STATUS: LeadStatus = 'new';

export function isLeadStatus(value: unknown): value is LeadStatus {
  return LEAD_STATUSES.some(({ id }) => id === value);
}
