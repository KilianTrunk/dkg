import { describe, it, expect } from 'vitest';
import { buildInitAutoUpdate } from '../src/commands/init.js';

// Guards the `dkg init` auto-update persistence decision. Both the decline
// path (PR #1295 round 3: must persist { enabled: false }, not fall through to
// the enabled network default) and channel/advanced-field preservation across
// reruns (round 1) have regressed before — these pin the behavior.
describe('buildInitAutoUpdate', () => {
  const proj = { projRepo: 'OriginTrail/dkg', projDefaultBranch: 'main' };
  const net = {
    repo: 'OriginTrail/dkg',
    branch: 'main',
    allowPrerelease: true,
    checkIntervalMinutes: 5,
  };

  it('decline on a fresh config persists { enabled: false } (so the daemon does NOT re-enable via the network default)', () => {
    const r = buildInitAutoUpdate({
      enableAutoUpdate: false,
      existingAutoUpdate: undefined,
      networkAutoUpdate: net,
      ...proj,
    });
    expect(r).toEqual({ enabled: false });
  });

  it('decline disables but preserves existing advanced fields (channel, intervals)', () => {
    const r = buildInitAutoUpdate({
      enableAutoUpdate: false,
      existingAutoUpdate: { enabled: true, channel: 'staging', checkIntervalMinutes: 10 },
      networkAutoUpdate: net,
      ...proj,
    });
    expect(r.enabled).toBe(false);
    expect(r.channel).toBe('staging');
    expect(r.checkIntervalMinutes).toBe(10);
  });

  it('enable preserves a local channel pin across the rerun', () => {
    const r = buildInitAutoUpdate({
      enableAutoUpdate: true,
      existingAutoUpdate: { enabled: true, channel: 'staging' },
      networkAutoUpdate: net,
      ...proj,
      answers: { repo: '', branch: '', allowPrerelease: true, sshKeyPath: '', interval: 5 },
    });
    expect(r.enabled).toBe(true);
    expect(r.channel).toBe('staging');
  });

  it('enable persists only fields that differ from the network/project defaults', () => {
    const r = buildInitAutoUpdate({
      enableAutoUpdate: true,
      existingAutoUpdate: undefined,
      networkAutoUpdate: net,
      ...proj,
      // Every answer equals the effective default → nothing extra is pinned.
      answers: { repo: 'OriginTrail/dkg', branch: 'main', allowPrerelease: true, sshKeyPath: '', interval: 5 },
    });
    expect(r).toEqual({ enabled: true, source: 'npm' });
  });

  it('enable persists a field that DOES differ from the default (e.g. allowPrerelease)', () => {
    const r = buildInitAutoUpdate({
      enableAutoUpdate: true,
      existingAutoUpdate: undefined,
      networkAutoUpdate: net, // allowPrerelease default = true
      ...proj,
      answers: { repo: 'OriginTrail/dkg', branch: 'main', allowPrerelease: false, sshKeyPath: '', interval: 5 },
    });
    expect(r).toEqual({ enabled: true, source: 'npm', allowPrerelease: false });
  });
});
