'use strict';

/**
 * issues/307 (2026-10-21): to size READ_CACHE_MAX_MB per tenant, the read
 * cache's stats also give the process's memory (the kept bytes are a JSON-size
 * estimate; the heap holds about 2.5 times that) and the container's limit.
 */

describe('read-cache stats: the process memory', () => {
  let controller;

  beforeEach(() => {
    jest.resetModules();
    controller = require('../src/api/read-cache/controllers/read-cache');
  });

  it('gives the memory in MB', () => {
    const MB = 1024 * 1024;
    const memory = controller.processMemory(
      { rss: 612.34 * MB, heapUsed: 301.06 * MB, heapTotal: 400 * MB, external: 9 * MB },
      { heap_size_limit: 4144 * MB },
      1536 * MB,
    );
    expect(memory).toEqual({ rssMB: 612.3, heapUsedMB: 301.1, heapLimitMB: 4144, containerLimitMB: 1536 });
  });

  it('reads the container limit from cgroup v2, then v1; none when unlimited', () => {
    const files = (map) => (file) => {
      if (!(file in map)) throw new Error('ENOENT');
      return map[file];
    };
    expect(controller.containerLimit(files({ '/sys/fs/cgroup/memory.max': '1610612736\n' }))).toBe(1610612736);
    expect(controller.containerLimit(files({ '/sys/fs/cgroup/memory.max': 'max\n' }))).toBeNull();
    expect(
      controller.containerLimit(files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '1073741824' })),
    ).toBe(1073741824);
    expect(
      controller.containerLimit(files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' })),
    ).toBeNull();
    expect(controller.containerLimit(files({}))).toBeNull();
  });

  it('the stats endpoint answers the cache figures and the memory', async () => {
    const stats = await controller({ strapi: {} }).stats();
    expect(stats).toHaveProperty('entries');
    expect(stats).toHaveProperty('evicted');
    expect(stats.memory.rssMB).toBeGreaterThan(0);
    expect(stats.memory.heapUsedMB).toBeGreaterThan(0);
    expect(stats.memory.heapLimitMB).toBeGreaterThan(stats.memory.heapUsedMB);
  });
});
