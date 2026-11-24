import { DurableObject } from 'cloudflare:workers';
import { DEFAULT_LEAD_STATUS, type LeadStatus } from '../../src/lib/lead-status';

export class LeadStatusStore extends DurableObject {
  async getMany(keys: string[]): Promise<Partial<Record<string, LeadStatus>>> {
    const statuses = await this.ctx.storage.get<LeadStatus>(keys);
    return Object.fromEntries(statuses);
  }

  async set(key: string, status: LeadStatus): Promise<void> {
    if (status === DEFAULT_LEAD_STATUS) {
      await this.clear(key);
      return;
    }
    await this.ctx.storage.put(key, status);
  }

  async clear(key: string): Promise<void> {
    await this.ctx.storage.delete(key);
  }
}
