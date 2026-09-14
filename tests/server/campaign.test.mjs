import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignState } from '../../server/campaign.mjs';
test('campaign visibility uses explicit opening and exclusive closing boundary', () => {
  const { startsAt, endsAt } = campaignState();
  assert.equal(campaignState(Date.parse(startsAt) - 1).active, false);
  assert.equal(campaignState(Date.parse(startsAt)).active, true);
  assert.equal(campaignState(Date.parse(endsAt) - 1).active, true);
  assert.equal(campaignState(Date.parse(endsAt)).active, false);
});
