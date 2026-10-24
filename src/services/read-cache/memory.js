'use strict';

/** The process's memory for the read-cache stats (issues/307, 328). */
const fs = require('fs');
const v8 = require('v8');

const MB = 1024 * 1024;
const mb = (bytes) => (Number.isFinite(bytes) ? Math.round((bytes / MB) * 10) / 10 : null);

// the container's memory limit (cgroup v2, then v1); null without one
const CGROUP_LIMITS = ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'];
function containerLimit(read = (file) => fs.readFileSync(file, 'utf8')) {
  for (const file of CGROUP_LIMITS) {
    try {
      const value = Number(String(read(file)).trim());
      // «max», or v1's «no limit» (a huge number)
      if (Number.isFinite(value) && value > 0 && value < 2 ** 50) return value;
    } catch {
      // not there: the next one
    }
  }
  return null;
}

/**
 * The process's memory, next to what the cache keeps: to size
 * READ_CACHE_MAX_MB per tenant (the kept bytes are a JSON-size estimate; the
 * heap holds about 2.5 times that).
 */
function processMemory(
  usage = process.memoryUsage(),
  heap = v8.getHeapStatistics(),
  limit = containerLimit(),
) {
  return {
    rssMB: mb(usage.rss),
    heapUsedMB: mb(usage.heapUsed),
    heapLimitMB: mb(heap.heap_size_limit),
    containerLimitMB: limit === null ? null : mb(limit),
  };
}

module.exports = { processMemory, containerLimit };
