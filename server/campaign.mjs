import { readFileSync } from 'node:fs';
export function campaignState(now = Date.now()) {
  const campaign = JSON.parse(readFileSync(new URL('../miniprogram/data/campaign.json', import.meta.url), 'utf8'));
  return { ...campaign, active: campaign.enabled === true && now >= Date.parse(campaign.startsAt) && now < Date.parse(campaign.endsAt) };
}
